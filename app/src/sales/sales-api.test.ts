import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { loadSales, recordCommercialLeadTriage } from "./sales-api";

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "ops@example.com",
    email: "ops@example.com",
    display_name: "Ops",
    role: "ops",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap",
    brand: "IronWrap",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["sales:read", "approvals:prepare"],
  allowed_actions: ["sales.read", "commercial.lead_triage.record"],
  csrf_token: "csrf-token",
  session_expires_at: "2026-07-11T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-11T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

describe("sales API", () => {
  it("loads the allowlisted Sales Desk through the same-origin BFF", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        source_updated_at: null,
        read_model_generated_at: "2026-07-11T12:00:00.000Z",
        stale_fields: [],
        permissions: ["sales:read"],
        allowed_actions: ["sales.read"],
        partial_sources: [],
        summary: {
          listed_leads: 0,
          triage_unresolved: 0,
          estimate_needs_review: 0,
          quote_needs_review: 0,
          quote_expired: 0,
          no_linked_consent_record: 0,
        },
        leads: [],
      }),
    );

    const response = await loadSales(fetcher);

    expect(response.summary.listed_leads).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/sales",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
  });

  it("records native triage with exact version, CSRF, and caller-stable idempotency", async () => {
    const response = {
      decision: {
        triage_decision_id: "commercial-triage:lead-a:v1",
        lead_id: "LEAD-A",
        lead_version: 2,
        lifecycle_status: "qualified",
        priority: "high",
        category: "storm damage",
        summary: "Qualified after reviewing the source-backed intake.",
        next_action: "Prepare the measurement review.",
        decided_at: "2026-07-11T12:01:00.000Z",
      },
      replayed: false,
      permit: {
        permit_id: "commercial-permit:lead-a:v1",
        replayed: false,
      },
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));

    await expect(
      recordCommercialLeadTriage(
        session,
        {
          leadId: "LEAD-A",
          expectedLeadVersion: 1,
          lifecycleStatus: "qualified",
          priority: "high",
          category: "storm damage",
          summary: "Qualified after reviewing the source-backed intake.",
          nextAction: "Prepare the measurement review.",
        },
        "commercial-lead-triage:stable-0001",
        fetcher,
      ),
    ).resolves.toEqual(response);

    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/commercial/lead-triage-decisions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "commercial-lead-triage:stable-0001",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      lead_id: "LEAD-A",
      expected_lead_version: 1,
      lifecycle_status: "qualified",
      priority: "high",
      category: "storm damage",
      summary: "Qualified after reviewing the source-backed intake.",
      next_action: "Prepare the measurement review.",
    });
  });
});
