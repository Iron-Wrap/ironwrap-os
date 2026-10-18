import { describe, expect, it } from "vitest";

import {
  decisionsReadModelSchema,
  nowResponseSchema,
  type DecisionsReadModel,
} from "./now-contracts";

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

function validDecisions(): DecisionsReadModel {
  const id = "approval:0000000000000001";
  return {
    version: 1,
    state: "ready",
    sources: [
      {
        kind: "lead_triage",
        state: "current",
        loaded_count: 1,
        has_more: false,
        next_cursor: null,
        read_model_generated_at: "2026-09-29T12:00:00.000Z",
      },
    ],
    items: [
      {
        key: `lead_triage:${id}`,
        kind: "lead_triage",
        id,
        version: 1,
        native_state: "pending",
        title: "Review lead note",
        summary: "Review the captured lead note.",
        job_id: null,
        updated_at: "2026-09-29T12:00:00.000Z",
        expires_at: "2026-09-30T12:00:00.000Z",
        review_href: `/approvals?review=${encodeURIComponent(id)}`,
      },
    ],
  };
}

describe("decisionsReadModelSchema", () => {
  it("accepts the bounded projection without inventing a model for older Now responses", () => {
    expect(nowResponseSchema.parse(validPayload()).decisions).toBeUndefined();
    expect(
      nowResponseSchema.parse({ ...validPayload(), decisions: validDecisions() }).decisions,
    ).toEqual(validDecisions());
  });

  it("rejects mutation fields, raw arguments, forged destinations and native-state drift", () => {
    for (const extra of [
      { allowed_actions: ["approve"] },
      { write_args_json: "fixture" },
      { review_href: "/approvals?review=another" },
      { key: "quote_revision:another" },
      { native_state: "executed" },
      { native_state: "published" },
    ]) {
      const model = validDecisions();
      expect(
        decisionsReadModelSchema.safeParse({ ...model, items: [{ ...model.items[0], ...extra }] })
          .success,
      ).toBe(false);
    }
  });

  it("refuses route-normalizing IDs and the wrong native identity format", () => {
    const lead = validDecisions().items[0]!;
    for (const [kind, id, route] of [
      ["lead_triage", "approval:short", "/approvals?review=approval%3Ashort"],
      ["quote_revision", "..", "/quote-revision-approvals/.."],
      ["postiz", "not-a-uuid", "/marketing/postiz/not-a-uuid"],
      ["quickbooks_final_invoice", "short", "/accounting/quickbooks/final-invoices/short"],
    ]) {
      const item = {
        ...lead,
        kind,
        id,
        key: `${kind}:${id}`,
        job_id: "job:fixture:1",
        review_href: route,
      };
      expect(
        decisionsReadModelSchema.safeParse({
          ...validDecisions(),
          sources: [{ ...validDecisions().sources[0], kind }],
          items: [item],
        }).success,
      ).toBe(false);
    }
  });

  it("requires truthful source counts, uniqueness, retirement and unavailable coverage", () => {
    const base = validDecisions();
    for (const override of [
      { loaded_count: 0 },
      { state: "unavailable" },
      { state: "retired" },
      { has_more: true, next_cursor: null },
      { next_cursor: "next" },
      { read_model_generated_at: null },
    ]) {
      expect(
        decisionsReadModelSchema.safeParse({
          ...base,
          sources: [{ ...base.sources[0], ...override }],
        }).success,
      ).toBe(false);
    }
    expect(decisionsReadModelSchema.safeParse({ ...base, sources: [] }).success).toBe(false);
    expect(
      decisionsReadModelSchema.safeParse({ ...base, items: [...base.items, ...base.items] })
        .success,
    ).toBe(false);
    expect(
      decisionsReadModelSchema.safeParse({ ...base, sources: [...base.sources, ...base.sources] })
        .success,
    ).toBe(false);
    const unavailable = {
      version: 1,
      state: "limited",
      items: [],
      sources: [
        {
          kind: "lead_triage",
          state: "unavailable",
          loaded_count: 0,
          has_more: null,
          next_cursor: null,
          read_model_generated_at: null,
        },
      ],
    };
    expect(decisionsReadModelSchema.safeParse(unavailable).success).toBe(true);
    expect(decisionsReadModelSchema.safeParse({ ...unavailable, state: "empty" }).success).toBe(
      false,
    );
    expect(decisionsReadModelSchema.safeParse({ ...unavailable, state: "ready" }).success).toBe(
      false,
    );
  });

  it("accepts an explicit partial page only with a bounded continuation cursor", () => {
    const base = validDecisions();
    const partial = {
      ...base,
      state: "limited",
      sources: [{ ...base.sources[0], state: "limited", has_more: true, next_cursor: "next_page" }],
    };
    expect(decisionsReadModelSchema.safeParse(partial).success).toBe(true);
    for (const cursor of [null, "", "../other", "x".repeat(1025)]) {
      expect(
        decisionsReadModelSchema.safeParse({
          ...partial,
          sources: [{ ...partial.sources[0], next_cursor: cursor }],
        }).success,
      ).toBe(false);
    }
  });
});

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
        title: "Final invoice needs a check",
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

  it("accepts the final-invoice card exactly as the Worker builds it", () => {
    // workers-bus/src/now-read-model.ts quickBooksCard: one fixed title for every state, the
    // amount as "CAD <balance>", and a citation that points at the same intent.
    const payload = validPayload();
    const href = "/accounting/quickbooks/final-invoices/qbo_final_01JEXAMPLE0001";
    const id = "qbo-final-invoice:qbo_final_01JEXAMPLE0001";
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
        id,
        tone: "attention",
        eyebrow: "QuickBooks final invoice",
        title: "Final invoice needs a check",
        detail: "CAD 1050.00",
        job_id: "JOB-0001",
        currency: "CAD",
        final_balance: "1050.00",
        invoice_state: "submitted",
        blocker_code: null,
        rejection_reason: null,
        next_step: "reconcile_provider_invoice",
        action: { label: "Review final invoice", href },
        citations: [{ id, label: "Final invoice record", source: "owned_read_model", href }],
      } as never,
    ];

    expect(nowResponseSchema.safeParse(payload).success).toBe(true);

    // Every binding to the intent still holds: title, id, amount and citation.
    const mutations: Array<(card: Record<string, unknown>) => void> = [
      (card) => (card.title = "Final invoice paid"),
      (card) => (card.id = "qbo-final-invoice:qbo_final_01JEXAMPLE0002"),
      (card) => (card.detail = "CAD 1051.00"),
      (card) =>
        (card.citations = [
          {
            id,
            label: "Final invoice record",
            source: "owned_read_model",
            href: "/accounting/quickbooks/final-invoices/qbo_final_01JEXAMPLE0002",
          },
        ]),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(payload);
      mutate(changed.ui.sections[0]!.cards[0] as unknown as Record<string, unknown>);
      expect(nowResponseSchema.safeParse(changed).success).toBe(false);
    }
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
