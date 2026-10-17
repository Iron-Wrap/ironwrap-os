import { describe, expect, it } from "vitest";

import { receiptIdFor } from "../evidence/evidence-test-harness";
import {
  OFFICE_ACTIONS,
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
  serviceCaseIntakeResponseSchema,
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
      evidenceReceiptIds: [receiptIdFor(1)],
      responseSlaMinutes: 1440,
    };
    const refused = serviceCaseIntakeInputSchema.safeParse(intake);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("emergency_response_window_exceeded");
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, responseSlaMinutes: 240 }).success,
    ).toBe(true);
  });

  it("reads evidence_files on a case detail as optional, with strictly shaped items", () => {
    // The case read stays usable when only its file list could not be checked (#362).
    const unchecked = serviceCaseDetailResponseSchema.parse(
      detailResponse({ evidence_files: [], evidence_files_unavailable: true }),
    );
    expect(unchecked.evidence_files_unavailable).toBe(true);
    expect(
      serviceCaseDetailResponseSchema.safeParse(
        detailResponse({ evidence_files: [], evidence_files_unavailable: "yes" as never }),
      ).success,
    ).toBe(false);
    const file = {
      receipt_id: receiptIdFor(1),
      file_name: "stain.jpg",
      content_type: "image/jpeg" as const,
      byte_size: 2_200_000,
    };
    expect(
      serviceCaseDetailResponseSchema.parse(detailResponse({ evidence_files: [file] }))
        .evidence_files,
    ).toEqual([file]);
    // Exactly as a healthy #362 read sends it: the list beside its marker.
    expect(
      serviceCaseDetailResponseSchema.parse(
        detailResponse({ evidence_files: [file], evidence_files_unavailable: false }),
      ),
    ).toMatchObject({ evidence_files: [file], evidence_files_unavailable: false });
    // A Worker that does not list files yet still reads, and the absence stays an absence.
    expect(serviceCaseDetailResponseSchema.parse(detailResponse()).evidence_files).toBeUndefined();
    expect(
      serviceCaseDetailResponseSchema.parse(detailResponse({ evidence_files: [] })).evidence_files,
    ).toEqual([]);
    for (const bad of [
      { ...file, receipt_id: "a".repeat(64) },
      { ...file, sha256: "a".repeat(64) },
      { ...file, content_type: "image/gif" },
      { ...file, byte_size: -1 },
      { file_name: "stain.jpg" },
    ]) {
      expect(
        serviceCaseDetailResponseSchema.safeParse(
          detailResponse({ evidence_files: [bad as never] }),
        ).success,
      ).toBe(false);
    }
    // The rest of the detail stays strict: an unknown top-level field is still refused.
    expect(
      serviceCaseDetailResponseSchema.safeParse({ ...detailResponse(), evidence_digest_files: [] })
        .success,
    ).toBe(false);
  });

  it("takes one to four receipt ids, or the typed digest the desk still sends, never both", () => {
    const intake = {
      customerId: "CUST-0001",
      propertyKey: "PROP-0001",
      roofJobId: "JOB-0001",
      severity: "standard" as const,
      symptomCode: "interior_water_stain",
      reportedChannel: "phone" as const,
      consentRef: "CONSENT-0001",
      evidenceReceiptIds: [receiptIdFor(1)],
      responseSlaMinutes: 1440,
    };
    expect(serviceCaseIntakeInputSchema.safeParse(intake).success).toBe(true);
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => receiptIdFor(index + 1));
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, evidenceReceiptIds: ids(4) }).success,
    ).toBe(true);
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, evidenceReceiptIds: ids(5) }).success,
    ).toBe(false);
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, evidenceReceiptIds: [] }).success,
    ).toBe(false);
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, evidenceReceiptIds: ["a".repeat(64)] })
        .success,
    ).toBe(false);
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...intake, intakeEvidenceDigest: "a".repeat(64) })
        .success,
    ).toBe(false);
    const { evidenceReceiptIds: _files, ...typed } = intake;
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...typed, intakeEvidenceDigest: "a".repeat(64) })
        .success,
    ).toBe(true);
    expect(
      serviceCaseIntakeInputSchema.safeParse({ ...typed, intakeEvidenceDigest: "nope" }).success,
    ).toBe(false);
    expect(serviceCaseIntakeInputSchema.safeParse(typed).success).toBe(false);
  });

  it("reads a repeated save as replayed, alongside opened and duplicate", () => {
    const response = {
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: OFFICE_ACTIONS,
      service_case: serviceCase(),
      original_case: null,
    };
    for (const result of ["opened", "duplicate", "replayed"]) {
      expect(serviceCaseIntakeResponseSchema.safeParse({ ...response, result }).success).toBe(true);
    }
    expect(
      serviceCaseIntakeResponseSchema.safeParse({ ...response, result: "merged" }).success,
    ).toBe(false);
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
      evidenceReceiptIds: [receiptIdFor(1)],
      responseSlaMinutes: 1440,
    });
    expect(parsed.success).toBe(false);
  });
});
