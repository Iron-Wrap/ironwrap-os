import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { API_PATHS } from "../lib/api-paths";
import {
  loadServiceCase,
  openCostRecoveryClaim,
  openServiceCase,
  recordServiceTriage,
} from "./service-api";
import { claim, detailResponse, serviceCase } from "./service-fixtures";

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
        intakeEvidenceDigest: "a".repeat(64),
        responseSlaMinutes: 1440,
      },
      fetcher,
    );

    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe(API_PATHS.serviceCases);
    expect((init?.headers as Headers).get("X-CSRF-Token")).toBe("csrf-token");
    const body = bodyOf(fetcher);
    expect(body.response_sla_minutes).toBe(1440);
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
          intakeEvidenceDigest: "a".repeat(64),
          responseSlaMinutes: 1440,
        },
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
        evidenceDigest: "b".repeat(64),
      },
      fetcher,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(API_PATHS.serviceCaseTriage("svc_case_0001"));
    const body = bodyOf(fetcher);
    expect(body).not.toHaveProperty("decided_by_user_id");
    expect(body).not.toHaveProperty("decided_by_role");
    expect(body.advisory_category).toBeNull();
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
        evidenceDigest: "b".repeat(64),
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
      "evidence_digest",
    ]);
  });

  it("reads a case detail over a same-origin encoded path", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(detailResponse()));
    await loadServiceCase("svc_case_0001", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/service-cases/svc_case_0001");
  });
});
