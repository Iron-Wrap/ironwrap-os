import { describe, expect, it } from "vitest";

import { nowResponseSchema } from "./now-contracts";

function validPayload() {
  return {
    version: 1,
    role: "owner",
    read_model_generated_at: "2026-08-13T08:00:00.000Z",
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    sources: [
      {
        id: "owner",
        state: "current",
        read_model_generated_at: "2026-08-13T07:59:00.000Z",
        stale_fields: [],
      },
    ],
    ui: {
      schema_version: 1,
      state: "ready",
      title: "What needs you now",
      explanation: "Resolve the first verified exception, then return for the next one.",
      sync_label: "Owned records are current for this view.",
      primary_action: {
        id: "open-job",
        label: "Open job",
        kind: "navigate",
        href: "/jobs/IW-1042%20A",
        reason: "A recorded production gate is blocked.",
        citation_ids: ["job-1"],
      },
      sections: [
        {
          id: "decide",
          title: "Decide first",
          summary: "One exception needs a decision.",
          cards: [
            {
              id: "card-1",
              tone: "critical",
              eyebrow: "Blocked gate",
              title: "Delivery confirmation is missing",
              detail: "The job cannot move until delivery is verified.",
              action: {
                id: "refresh-job",
                label: "Refresh live records",
                kind: "refresh",
                href: null,
                reason: "The source may have recovered.",
                citation_ids: ["job-1"],
              },
              citations: [
                {
                  id: "job-1",
                  label: "Production record",
                  source: "owned_read_model",
                  href: "/production",
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("nowResponseSchema", () => {
  it("accepts only the declarative Now component contract", () => {
    expect(nowResponseSchema.safeParse(validPayload()).success).toBe(true);
  });

  it("accepts the same trusted component contract for sales", () => {
    const payload = validPayload();
    payload.role = "sales";

    expect(nowResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts the same trusted component contract for production", () => {
    const payload = validPayload();
    payload.role = "production";

    expect(nowResponseSchema.safeParse(payload).success).toBe(true);

    (payload.ui.sections[0]!.cards[0] as unknown as { final_balance: string }).final_balance =
      "1000000000.00";
    expect(nowResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts one declarative accounting finance card bound to its exact intent", () => {
    const payload = validPayload();
    const href = "/accounting/quickbooks/final-invoices/qbo_final_01JEXAMPLE0001";
    payload.role = "accounting";
    payload.sources = [
      {
        id: "quickbooks_final_invoices",
        state: "current",
        read_model_generated_at: "2026-08-13T07:59:00.000Z",
        stale_fields: [],
      },
    ];
    payload.ui.primary_action = null as never;
    payload.ui.sections[0]!.cards = [
      {
        kind: "quickbooks_final_invoice",
        id: "qbo-final-invoice:qbo_final_01JEXAMPLE0001",
        tone: "attention",
        eyebrow: "QuickBooks final invoice",
        title: "Final invoice pending review",
        detail: "CAD 1050.00",
        job_id: "JOB-0001",
        currency: "CAD",
        final_balance: "1050.00",
        invoice_state: "pending_review",
        blocker_code: null,
        rejection_reason: null,
        next_step: "refresh_candidate",
        action: { label: "Review final invoice", href },
        citations: [
          {
            id: "qbo-citation-1",
            label: "Completion packet",
            source: "owned_read_model",
            href,
          },
        ],
      } as never,
    ];

    expect(nowResponseSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    "/accounting/quickbooks/final-invoices/short",
    "/accounting/quickbooks/final-invoices/a%2Fb12345678901234",
    "/accounting/quickbooks/final-invoices/%252Fetc1234567890123",
    "/accounting/quickbooks/final-invoices/qbo_final_01JEXAMPLE0001/extra",
  ])("rejects malformed QuickBooks finance href %s", (href) => {
    const payload = validPayload();
    payload.ui.primary_action.href = href;

    expect(nowResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts a bounded Postiz intent detail link", () => {
    const payload = validPayload();
    payload.ui.primary_action.href = "/marketing/postiz/11111111-1111-4111-8111-111111111111";
    payload.ui.sections[0]!.cards[0]!.citations[0]!.href =
      "/marketing/postiz/11111111-1111-4111-8111-111111111111";

    expect(nowResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts the bounded QuickBooks settings route for pre-intent holds", () => {
    const payload = validPayload();
    payload.ui.primary_action.href = "/accounting/quickbooks";
    payload.ui.sections[0]!.cards[0]!.citations[0]!.href = "/accounting/quickbooks";

    expect(nowResponseSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    "https://example.invalid/jobs/IW-1042",
    "//example.invalid",
    "/admin",
    "/jobs/a/b",
    "/marketing/postiz/a/b",
    "/marketing/postiz/%2F",
  ])("rejects untrusted navigation href %s", (href) => {
    const payload = validPayload();
    payload.ui.primary_action.href = href;

    expect(nowResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("enforces href semantics for navigation and refresh actions", () => {
    const navigateWithoutHref = validPayload();
    navigateWithoutHref.ui.primary_action.href = null as never;
    const refreshWithHref = validPayload();
    refreshWithHref.ui.sections[0]!.cards[0]!.action!.href = "/owner" as never;

    expect(nowResponseSchema.safeParse(navigateWithoutHref).success).toBe(false);
    expect(nowResponseSchema.safeParse(refreshWithHref).success).toBe(false);
  });

  it("rejects fields outside the trusted component schema", () => {
    const payload = validPayload();
    Object.assign(payload.ui.sections[0]!.cards[0]!, {
      html: "<script>window.location='https://example.invalid'</script>",
    });

    expect(nowResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects action citations that are absent from the bounded read", () => {
    const payload = validPayload();
    payload.ui.primary_action.citation_ids = ["missing-record"];

    expect(nowResponseSchema.safeParse(payload).success).toBe(false);
  });
});
