import { describe, expect, it } from "vitest";

import {
  OWNER_ACTIONS,
  claim,
  detailResponse,
  listResponse,
  serviceCase,
} from "./service-fixtures";
import {
  costRecoveryClaimSchema,
  costRecoveryMutationResponseSchema,
  serviceCaseDetailResponseSchema,
  serviceCaseIntakeInputSchema,
  serviceCaseListResponseSchema,
  serviceCaseSchema,
} from "./service-contracts";

describe("service lifecycle contracts", () => {
  it("accepts the projections the BFF actually sends", () => {
    expect(serviceCaseListResponseSchema.parse(listResponse()).service_cases).toHaveLength(1);
    expect(serviceCaseDetailResponseSchema.parse(detailResponse()).events).toHaveLength(1);
  });

  it("refuses a case whose evidence digest is not a digest", () => {
    const parsed = serviceCaseSchema.safeParse(serviceCase({ intake_evidence_digest: "nope" }));
    expect(parsed.success).toBe(false);
  });

  it("refuses a projection that leaks the tenant or the effect request hash", () => {
    const leaky = { ...serviceCase(), tenant_id: "ironwrap" };
    expect(serviceCaseSchema.safeParse(leaky).success).toBe(false);
    const hashed = { ...claim(), request_hash: "f".repeat(64) };
    expect(costRecoveryClaimSchema.safeParse(hashed).success).toBe(false);
  });

  it("keeps the governance facts a cost-recovery claim must carry", () => {
    const parsed = costRecoveryClaimSchema.parse(claim());
    expect(parsed.actor_role).toBe("owner");
    expect(parsed.authority_ref).toBe("svc_triage_0001");
    expect(parsed.correlation_id).toBe("svc-case:svc_case_0001");
    for (const missing of ["actor_user_id", "authority_ref", "correlation_id", "deadline_at"]) {
      const withoutFact: Record<string, unknown> = { ...claim() };
      delete withoutFact[missing];
      expect(costRecoveryClaimSchema.safeParse(withoutFact).success).toBe(false);
    }
  });

  it("keeps legacy leased claims readable but refuses removed execution mutation results", () => {
    expect(
      costRecoveryClaimSchema.safeParse(
        claim({
          state: "leased",
          attempt_count: 1,
          attempt_mode: "leased",
          lease_ref: "svc-recovery:0123456789abcdef",
          lease_expires_at: "2026-08-20T10:00:00.000Z",
          attempted_at: "2026-08-20T09:00:00.000Z",
        }),
      ).success,
    ).toBe(true);

    const response = {
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: OWNER_ACTIONS,
      claim: claim(),
    };
    expect(
      costRecoveryMutationResponseSchema.safeParse({ ...response, result: "opened" }).success,
    ).toBe(true);
    expect(
      costRecoveryMutationResponseSchema.safeParse({ ...response, result: "claimed" }).success,
    ).toBe(false);
    expect(
      costRecoveryMutationResponseSchema.safeParse({ ...response, result: "already_attempted" })
        .success,
    ).toBe(false);
  });

  it("never lets an emergency intake declare a routine response window", () => {
    const intake = {
      customerId: "CUST-0001",
      propertyKey: "PROP-0001",
      roofJobId: "JOB-0001",
      severity: "emergency" as const,
      symptomCode: "active_leak_occupied_room",
      reportedChannel: "phone" as const,
      consentRef: "CONSENT-0001",
      intakeEvidenceDigest: "a".repeat(64),
      responseSlaMinutes: 1440,
    };
    const refused = serviceCaseIntakeInputSchema.safeParse(intake);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("emergency_response_window_exceeded");
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, responseSlaMinutes: 240 }).success,
    ).toBe(true);
  });

  it("refuses a symptom code that is not a lowercase code", () => {
    const parsed = serviceCaseIntakeInputSchema.safeParse({
      customerId: "CUST-0001",
      propertyKey: "PROP-0001",
      roofJobId: "JOB-0001",
      severity: "standard",
      symptomCode: "Interior Water Stain",
      reportedChannel: "phone",
      consentRef: "CONSENT-0001",
      intakeEvidenceDigest: "a".repeat(64),
      responseSlaMinutes: 1440,
    });
    expect(parsed.success).toBe(false);
  });
});
