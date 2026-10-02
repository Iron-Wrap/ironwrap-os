import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  createLead,
  createOfficeLead,
  loadOfficeLeadReceipt,
  resumeOfficeLeadIntake,
  loadSalesLead,
  newOfficeLeadRequestId,
  loadSales,
  recordCommercialLeadTriage,
} from "./sales-api";

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

const officeInput = {
  name: "Morgan Example",
  email: "morgan@example.invalid",
  phone: "",
  address: "",
  city: "",
  province: "",
  postal_code: "",
  service: "Custom trim",
  message: "Customer request",
  intake_source: "referral" as const,
  preferred_contact_channel: null,
  email_estimate_follow_up_consent: false,
};
const requestId = "office-lead:11111111-1111-4111-8111-111111111111";
const processingReceipt = {
  version: 1,
  receipt: {
    request_id: requestId,
    state: "processing",
    outcome: null,
    canonical_envelope_id: null,
    lead_id: null,
    submitted_details_applied: null,
    captured_at: "2026-09-30T12:00:00.000Z",
    details: null,
  },
};

describe("durable office intake transport", () => {
  it("opts into receipt creation with caller-stable identity and real capture fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(processingReceipt));
    await createOfficeLead(session, officeInput, requestId, fetcher);
    await createOfficeLead(session, officeInput, requestId, fetcher);
    for (const [path, init] of fetcher.mock.calls) {
      expect(path).toBe("/api/v1/sales/leads?include_receipt=1");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(requestId);
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe(session.csrf_token);
      expect(JSON.parse(String(init?.body))).toEqual(officeInput);
    }
    expect(newOfficeLeadRequestId()).toMatch(/^office-lead:[a-f0-9-]{36}$/);
  });
  it("reads receipts without contact data or mutation headers and rejects a different request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(processingReceipt));
    await loadOfficeLeadReceipt(requestId, fetcher);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe(`/api/v1/sales/intakes/${encodeURIComponent(requestId)}`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("idempotency-key")).toBeNull();
    const wrong = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...processingReceipt,
        receipt: {
          ...processingReceipt.receipt,
          request_id: "office-lead:22222222-2222-4222-8222-222222222222",
        },
      }),
    );
    await expect(loadOfficeLeadReceipt(requestId, wrong)).rejects.toThrow();
  });
  it("does not automatically retry unknown writes and preserves legacy create", async () => {
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error("Connection interrupted"));
    await expect(createOfficeLead(session, officeInput, requestId, failed)).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
    const legacy = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        lead: {
          envelope_id: "ow_legacy",
          canonical_envelope_id: "ow_legacy",
          tenant_id: "ironwrap",
          status: "pending_jn_push",
          duplicate: false,
          queue: null,
        },
      }),
    );
    await createLead(session, officeInput, legacy);
    expect(legacy.mock.calls[0]?.[0]).toBe("/api/v1/sales/leads");
    expect(JSON.parse(String(legacy.mock.calls[0]?.[1]?.body))).toEqual({
      name: officeInput.name,
      email: officeInput.email,
      service: officeInput.service,
      message: officeInput.message,
    });
  });
  it("uses the exact lead endpoint and rejects another valid lead in the response", async () => {
    const id = `lead:ironwrap:${"a".repeat(64)}`;
    const lead = {
      id,
      envelope_id: "ow_original",
      source: "manual",
      received_at: null,
      transport_status: null,
      intent_queue: null,
      contact: { display_name: "Morgan Example", phone: null, email: "morgan@example.invalid" },
      triage: { status: "Untriaged", summary: null, version: 1 },
      job: null,
      estimate: null,
      quote: null,
      proposal: null,
      consent: { context: "no_linked_record", records: [] },
      partial_fields: [],
      attention: [],
    };
    const response = {
      version: 1,
      read_model_generated_at: "2026-09-30T12:00:00.000Z",
      permissions: ["sales:read"],
      allowed_actions: [],
      stale_fields: [],
      partial_sources: [],
      lead,
      intake: null,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    await expect(loadSalesLead(id, fetcher)).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/sales/leads/${encodeURIComponent(id)}`);
    const wrong = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ...response, lead: { ...lead, id: `lead:ironwrap:${"b".repeat(64)}` } }),
      );
    await expect(loadSalesLead(id, wrong)).rejects.toThrow();
    await expect(loadSalesLead("../other", fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("explicit receipt resume sends only the saved identity and CSRF, with no new key or automatic retry", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(processingReceipt));
  await expect(resumeOfficeLeadIntake(session, requestId, fetcher)).resolves.toEqual(
    processingReceipt,
  );
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe(`/api/v1/sales/intakes/${encodeURIComponent(requestId)}/resume`);
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({});
  expect(new Headers(init?.headers).get("x-csrf-token")).toBe(session.csrf_token);
  expect(new Headers(init?.headers).get("idempotency-key")).toBeNull();
  const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error("Connection interrupted"));
  await expect(resumeOfficeLeadIntake(session, requestId, failed)).rejects.toThrow();
  expect(failed).toHaveBeenCalledTimes(1);
  const mismatch = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      ...processingReceipt,
      receipt: {
        ...processingReceipt.receipt,
        request_id: "office-lead:22222222-2222-4222-8222-222222222222",
      },
    }),
  );
  await expect(resumeOfficeLeadIntake(session, requestId, mismatch)).rejects.toThrow();
});
