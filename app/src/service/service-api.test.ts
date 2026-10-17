import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { receiptIdFor } from "../evidence/evidence-test-harness";
import { API_PATHS } from "../lib/api-paths";
import {
  closeServiceCase,
  issueServiceRemedy,
  loadServiceCase,
  openCostRecoveryClaim,
  openServiceCase,
  recordCustomerServiceDecision,
  recordServiceDiagnosis,
  recordServiceTriage,
  verifyServiceRemedy,
} from "./service-api";
import { claim, detailResponse, diagnosis, remedy, serviceCase } from "./service-fixtures";

const session = { csrf_token: "csrf-token" } as AuthenticatedSession;

const envelope = {
  version: 1,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  allowed_actions: ["service_case.read"],
};

function bodyOf(fetcher: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

describe("service lifecycle API client", () => {
  it("sends the intake facts only, with CSRF and without a derived due time", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...envelope,
        result: "opened",
        service_case: serviceCase(),
        original_case: null,
      }),
    );

    await openServiceCase(
      session,
      {
        customerId: "CUST-0001",
        propertyKey: "PROP-0001",
        roofJobId: "JOB-0001",
        severity: "standard",
        symptomCode: "interior_water_stain",
        reportedChannel: "phone",
        consentRef: "CONSENT-0001",
        evidenceReceiptIds: [receiptIdFor(1)],
        responseSlaMinutes: 1440,
      },
      "intake-key-0001",
      fetcher,
    );

    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe(API_PATHS.serviceCases);
    expect((init?.headers as Headers).get("X-CSRF-Token")).toBe("csrf-token");
    // The save carries the same key the files were uploaded under, so a repeat is a replay.
    expect((init?.headers as Headers).get("Idempotency-Key")).toBe("intake-key-0001");
    const body = bodyOf(fetcher);
    expect(body.response_sla_minutes).toBe(1440);
    expect(body.evidence_receipt_ids).toEqual([receiptIdFor(1)]);
    expect(body).not.toHaveProperty("intake_evidence_digest");
    // The bus derives the due time and the case id; the browser never proposes either.
    expect(body).not.toHaveProperty("response_due_at");
    expect(body).not.toHaveProperty("service_case_id");
    expect(body).not.toHaveProperty("opened_by_user_id");
  });

  it("refuses to send an emergency intake behind a routine window", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      openServiceCase(
        session,
        {
          customerId: "CUST-0001",
          propertyKey: "PROP-0001",
          roofJobId: "JOB-0001",
          severity: "emergency",
          symptomCode: "active_leak_occupied_room",
          reportedChannel: "phone",
          consentRef: "CONSENT-0001",
          evidenceReceiptIds: [receiptIdFor(1)],
          responseSlaMinutes: 1440,
        },
        "intake-key-0001",
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never sends a triage decision maker: the session is the authority", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...envelope,
        service_case: serviceCase({ state: "triaged", version: 2, last_event_type: "triaged" }),
        triage: {
          triage_id: "svc_triage_0001",
          service_case_id: "svc_case_0001",
          tenant_id: "ironwrap",
          case_version: 1,
          advisory_source: "none",
          advisory_category: null,
          advisory_confidence_bps: null,
          final_category: "workmanship",
          responsibility: "ironwrap_workmanship",
          authority_kind: "human",
          decided_by_user_id: "appu_ops",
          decided_by_role: "ops",
          evidence_digest: "b".repeat(64),
          decided_at: "2026-08-18T11:00:00.000Z",
          created_at: "2026-08-18T11:00:00.000Z",
        },
      }),
    );

    await recordServiceTriage(
      session,
      "svc_case_0001",
      {
        advisorySource: "none",
        finalCategory: "workmanship",
        responsibility: "ironwrap_workmanship",
        evidenceReceiptIds: [receiptIdFor(1)],
      },
      fetcher,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(API_PATHS.serviceCaseTriage("svc_case_0001"));
    const body = bodyOf(fetcher);
    expect(body).not.toHaveProperty("decided_by_user_id");
    expect(body).not.toHaveProperty("decided_by_role");
    expect(body.advisory_category).toBeNull();
    expect(body.evidence_receipt_ids).toEqual([receiptIdFor(1)]);
    expect(body).not.toHaveProperty("evidence_digest");
  });

  it("sends a claim as a bounded intent, never an identifier or a provider instruction", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...envelope, result: "opened", claim: claim() }));

    await openCostRecoveryClaim(
      session,
      "svc_case_0001",
      {
        counterpartyKind: "manufacturer",
        counterpartyRef: "SUP-SHINGLE-CO",
        claimBasisCode: "material_defect_granule_loss",
        claimedAmountCents: 150_000,
        evidenceReceiptIds: [receiptIdFor(1)],
        deadlineAt: "2026-09-19T09:00:00.000Z",
      },
      fetcher,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      API_PATHS.serviceCaseCostRecoveryClaims("svc_case_0001"),
    );
    const body = bodyOf(fetcher);
    expect(Object.keys(body).sort()).toEqual([
      "claim_basis_code",
      "claimed_amount_cents",
      "counterparty_kind",
      "counterparty_ref",
      "deadline_at",
      "evidence_receipt_ids",
    ]);
  });

  it("carries the files of every step as receipt ids, with no typed digest anywhere", async () => {
    const receipts = [receiptIdFor(1), receiptIdFor(2)];
    const stepResponse = {
      ...envelope,
      service_case: serviceCase(),
    };
    const steps: Array<[string, (fetcher: typeof fetch) => Promise<unknown>, unknown, string[]]> = [
      [
        "diagnosis",
        (fetcher) =>
          recordServiceDiagnosis(
            session,
            "svc_case_0001",
            {
              rootCauseCode: "granule_loss_defect",
              correctiveActionCode: "replace_affected_field",
              workPackageRef: "wp:JOB-0001:service",
              workPackageVersion: 1,
              warrantyReserveCents: 120_000,
              evidenceReceiptIds: receipts,
            },
            fetcher,
          ),
        { ...stepResponse, diagnosis: diagnosis() },
        [
          "corrective_action_code",
          "evidence_receipt_ids",
          "root_cause_code",
          "warranty_reserve_cents",
          "work_package_ref",
          "work_package_version",
        ],
      ],
      [
        "remedy",
        (fetcher) =>
          issueServiceRemedy(
            session,
            "svc_case_0001",
            {
              scheduledStartAt: "2026-08-25T14:00:00.000Z",
              scheduledEndAt: "2026-08-25T20:00:00.000Z",
              evidenceReceiptIds: receipts,
            },
            fetcher,
          ),
        { ...stepResponse, remedy: remedy() },
        ["evidence_receipt_ids", "scheduled_end_at", "scheduled_start_at"],
      ],
      [
        "verification",
        (fetcher) =>
          verifyServiceRemedy(
            session,
            "svc_case_0001",
            "svc_remedy_0001",
            { outcome: "verified", evidenceReceiptIds: receipts, costActualCents: 1000 },
            fetcher,
          ),
        { ...stepResponse, remedy: remedy() },
        ["cost_actual_cents", "evidence_receipt_ids", "failure_code", "outcome"],
      ],
      [
        "customer decision",
        (fetcher) =>
          recordCustomerServiceDecision(
            session,
            "svc_case_0001",
            "svc_remedy_0001",
            { decision: "accepted", acceptanceRef: "ACCEPT-1", evidenceReceiptIds: receipts },
            fetcher,
          ),
        { ...stepResponse, remedy: remedy() },
        ["acceptance_ref", "decision", "dispute_code", "evidence_receipt_ids"],
      ],
      [
        "closure with files",
        (fetcher) =>
          closeServiceCase(
            session,
            "svc_case_0001",
            { closureReason: "remedied_accepted", evidenceReceiptIds: receipts },
            fetcher,
          ),
        stepResponse,
        ["closure_reason", "detail_code", "evidence_receipt_ids"],
      ],
      [
        "closure without files",
        (fetcher) =>
          closeServiceCase(
            session,
            "svc_case_0001",
            { closureReason: "remedied_accepted" },
            fetcher,
          ),
        stepResponse,
        ["closure_reason", "detail_code"],
      ],
    ];
    for (const [label, send, response, keys] of steps) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
      await send(fetcher);
      const body = bodyOf(fetcher);
      expect(Object.keys(body).sort(), label).toEqual(keys);
      if (keys.includes("evidence_receipt_ids")) {
        expect(body.evidence_receipt_ids, label).toEqual(receipts);
      }
    }
  });

  it("sends the digest the case page still types under each step's own field", async () => {
    const digest = "c".repeat(64);
    const stepResponse = { ...envelope, service_case: serviceCase() };
    const steps: Array<[string, (fetcher: typeof fetch) => Promise<unknown>, unknown, string]> = [
      [
        "triage",
        (fetcher) =>
          recordServiceTriage(
            session,
            "svc_case_0001",
            {
              advisorySource: "none",
              finalCategory: "workmanship",
              responsibility: "ironwrap_workmanship",
              evidenceDigest: digest,
            },
            fetcher,
          ),
        stepResponse,
        "evidence_digest",
      ],
      [
        "diagnosis",
        (fetcher) =>
          recordServiceDiagnosis(
            session,
            "svc_case_0001",
            {
              rootCauseCode: "granule_loss_defect",
              correctiveActionCode: "replace_affected_field",
              workPackageRef: "wp:JOB-0001:service",
              workPackageVersion: 1,
              warrantyReserveCents: 120_000,
              evidenceDigest: digest,
            },
            fetcher,
          ),
        { ...stepResponse, diagnosis: diagnosis() },
        "evidence_digest",
      ],
      [
        "remedy",
        (fetcher) =>
          issueServiceRemedy(
            session,
            "svc_case_0001",
            {
              scheduledStartAt: "2026-08-25T14:00:00.000Z",
              scheduledEndAt: "2026-08-25T20:00:00.000Z",
              partsManifestDigest: digest,
            },
            fetcher,
          ),
        { ...stepResponse, remedy: remedy() },
        "parts_manifest_digest",
      ],
      [
        "verification",
        (fetcher) =>
          verifyServiceRemedy(
            session,
            "svc_case_0001",
            "svc_remedy_0001",
            { outcome: "verified", fieldEvidenceDigest: digest, costActualCents: 1000 },
            fetcher,
          ),
        { ...stepResponse, remedy: remedy() },
        "field_evidence_digest",
      ],
      [
        "customer decision",
        (fetcher) =>
          recordCustomerServiceDecision(
            session,
            "svc_case_0001",
            "svc_remedy_0001",
            { decision: "accepted", acceptanceRef: "ACCEPT-1", evidenceDigest: digest },
            fetcher,
          ),
        { ...stepResponse, remedy: remedy() },
        "evidence_digest",
      ],
      [
        "closure",
        (fetcher) =>
          closeServiceCase(
            session,
            "svc_case_0001",
            { closureReason: "remedied_accepted", evidenceDigest: digest },
            fetcher,
          ),
        stepResponse,
        "evidence_digest",
      ],
      [
        "claim",
        (fetcher) =>
          openCostRecoveryClaim(
            session,
            "svc_case_0001",
            {
              counterpartyKind: "manufacturer",
              counterpartyRef: "SUP-SHINGLE-CO",
              claimBasisCode: "material_defect_granule_loss",
              claimedAmountCents: 150_000,
              evidenceDigest: digest,
              deadlineAt: "2026-09-19T09:00:00.000Z",
            },
            fetcher,
          ),
        { ...envelope, result: "opened", claim: claim() },
        "evidence_digest",
      ],
    ];
    for (const [label, send, response, field] of steps) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
      // Only the request matters here; a reply this test does not shape fully may be refused.
      await send(fetcher).catch(() => undefined);
      const body = bodyOf(fetcher);
      expect(body[field], label).toBe(digest);
      expect(body, label).not.toHaveProperty("evidence_receipt_ids");
    }
  });

  it("opens an intake with a typed digest without a key, but never files without one", async () => {
    const intake = {
      customerId: "CUST-0001",
      propertyKey: "PROP-0001",
      roofJobId: "JOB-0001",
      severity: "standard" as const,
      symptomCode: "interior_water_stain",
      reportedChannel: "phone" as const,
      consentRef: "CONSENT-0001",
      responseSlaMinutes: 1440,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...envelope,
        result: "opened",
        service_case: serviceCase(),
        original_case: null,
      }),
    );
    await openServiceCase(
      session,
      { ...intake, intakeEvidenceDigest: "c".repeat(64) },
      undefined,
      fetcher,
    );
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect((init?.headers as Headers).get("Idempotency-Key")).toBeNull();
    expect(bodyOf(fetcher).intake_evidence_digest).toBe("c".repeat(64));
    expect(bodyOf(fetcher)).not.toHaveProperty("evidence_receipt_ids");

    const unsent = vi.fn<typeof fetch>();
    await expect(
      openServiceCase(
        session,
        { ...intake, evidenceReceiptIds: [receiptIdFor(1)] },
        undefined,
        unsent,
      ),
    ).rejects.toThrow("needs the key");
    expect(unsent).not.toHaveBeenCalled();
  });

  it("reads a repeated intake as the case it already made", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...envelope,
        result: "replayed",
        service_case: serviceCase(),
        original_case: null,
      }),
    );
    const response = await openServiceCase(
      session,
      {
        customerId: "CUST-0001",
        propertyKey: "PROP-0001",
        roofJobId: "JOB-0001",
        severity: "standard",
        symptomCode: "interior_water_stain",
        reportedChannel: "phone",
        consentRef: "CONSENT-0001",
        evidenceReceiptIds: [receiptIdFor(1)],
        responseSlaMinutes: 1440,
      },
      "intake-key-0001",
      fetcher,
    );
    expect(response.result).toBe("replayed");
  });

  it("reads a case detail over a same-origin encoded path", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(detailResponse()));
    await loadServiceCase("svc_case_0001", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/service-cases/svc_case_0001");
  });
});
