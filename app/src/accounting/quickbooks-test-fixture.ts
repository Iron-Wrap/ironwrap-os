import type { QuickBooksFinalInvoiceResponse } from "./quickbooks-contracts";

const hash = (character: string) => character.repeat(64);

export function quickBooksFinalInvoiceFixture(): QuickBooksFinalInvoiceResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-13T12:00:00.000Z",
    permissions: ["quickbooks:read", "quickbooks:review", "quickbooks:reconcile"],
    allowed_actions: ["approve", "reject", "reconcile", "refresh"],
    connection: {
      state: "connected",
      realm_id: "123456789",
      last_connected_at: "2026-08-13T11:00:00.000Z",
    },
    intent: {
      id: "qbo_final_01JEXAMPLE0001",
      job_id: "JOB-0001",
      shop_order_id: null,
      state: "pending_review",
      version: 1,
      currency: "CAD",
      amounts: {
        subtotal: "1000.00",
        tax: "50.00",
        already_invoiced: "0.00",
        final_balance: "1050.00",
      },
      tax: { code: "GST", rate: "5.0000" },
      invoice_date: "2026-08-13",
      due_date: "2026-09-12",
      lines: [{ description_code: "RESIDENTIAL_ACCEPTED_QUOTE", amount: "1000.00" }],
      basis: {
        basis_hash: hash("a"),
        completion_id: "COMP-0001",
        completion_version: 1,
        completion_hash: hash("b"),
        quote_id: "QUOTE-0001",
        quote_version: 1,
        quote_hash: hash("c"),
        changes_hash: hash("d"),
      },
      blocker: null,
      citations: [
        {
          id: "citation-1",
          label: "completion_packet",
          source: "Frappe",
          source_ref: "Frappe:Roof Completion Packet:COMP-0001",
          sha256: hash("b"),
        },
        {
          id: "citation-2",
          label: "accepted_quote",
          source: "Frappe",
          source_ref: "Frappe:Customer Quote:QUOTE-0001",
          sha256: hash("c"),
        },
      ],
      rejection_reason: null,
      provider: null,
      created_at: "2026-08-13T10:00:00.000Z",
      updated_at: "2026-08-13T12:00:00.000Z",
    },
  };
}
