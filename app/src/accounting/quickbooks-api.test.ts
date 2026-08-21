import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  approveQuickBooksFinalInvoice,
  connectQuickBooks,
  loadQuickBooksConnection,
  loadQuickBooksFinalInvoice,
  newQuickBooksActionKey,
  reconcileQuickBooksFinalInvoice,
  rejectQuickBooksFinalInvoice,
  removeQuickBooksFromIronWrap,
  saveQuickBooksFinalInvoiceMapping,
} from "./quickbooks-api";
import { quickBooksFinalInvoiceFixture } from "./quickbooks-test-fixture";

const session = {
  csrf_token: "csrf-qbo",
} as AuthenticatedSession;
const intentId = "qbo_final_01JEXAMPLE0001";
const expectedOrigin = "https://os.example.invalid";
const redirectUri = `${expectedOrigin}/oauth/quickbooks/callback`;
const connectUrl = (() => {
  const query = new URLSearchParams({
    client_id: "client_123",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    state: "OpaqueState_123456789",
  });
  return `https://appcenter.intuit.com/connect/oauth2?${query.toString()}`;
})();

describe("QuickBooks API client", () => {
  it("uses only the bounded same-origin detail and command routes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) =>
      path === "/api/v1/quickbooks/connect"
        ? Response.json({
            version: 1,
            connect_url: connectUrl,
            return_path: "/accounting/quickbooks",
            expires_at: "2026-08-13T12:10:00.000Z",
            callback_origin: expectedOrigin,
            redirect_uri: redirectUri,
          })
        : path === "/api/v1/quickbooks/connection"
          ? Response.json({
              version: 1,
              state: "connected",
              connection_version: 4,
              realm_id: "123456789",
              last_connected_at: "2026-08-13T11:00:00.000Z",
              allowed_actions: ["remove_from_ironwrap", "refresh"],
            })
          : path === "/api/v1/quickbooks/disconnect"
            ? Response.json({
                version: 1,
                state: "revoked",
                connection_version: 4,
                realm_id: null,
                last_connected_at: null,
                allowed_actions: ["connect", "refresh"],
              })
            : path === "/api/v1/quickbooks/final-invoice-mappings"
              ? Response.json({
                  version: 1,
                  state: "connected",
                  connection_version: 4,
                  realm_id: "123456789",
                  last_connected_at: "2026-08-13T11:00:00.000Z",
                  allowed_actions: ["remove_from_ironwrap", "refresh"],
                })
              : Response.json(quickBooksFinalInvoiceFixture()),
    );

    await loadQuickBooksFinalInvoice(intentId, fetcher);
    await loadQuickBooksConnection(fetcher);
    await connectQuickBooks(session, "quickbooks:connect:test", fetcher, expectedOrigin);
    await approveQuickBooksFinalInvoice(session, intentId, 1, "quickbooks:approve:test", fetcher);
    await rejectQuickBooksFinalInvoice(
      session,
      intentId,
      2,
      "evidence_incomplete",
      "quickbooks:reject:test",
      fetcher,
    );
    await reconcileQuickBooksFinalInvoice(
      session,
      intentId,
      3,
      "quickbooks:reconcile:test",
      fetcher,
    );
    await removeQuickBooksFromIronWrap(session, 4, "quickbooks:remove:test", fetcher);
    await saveQuickBooksFinalInvoiceMapping(
      session,
      {
        roof_job_id: "JOB-0001",
        qbo_customer_id: "501",
        qbo_item_id: "601",
        qbo_tax_code_id: "701",
        qbo_terms_id: "801",
        jurisdiction: "CA-AB",
        tax_code: "GST",
        payment_terms_days: 30,
        correction_reason: null,
      },
      "quickbooks:mapping:test",
      fetcher,
    );

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/quickbooks/final-invoices/${intentId}`,
      "/api/v1/quickbooks/connection",
      "/api/v1/quickbooks/connect",
      `/api/v1/quickbooks/final-invoices/${intentId}/approve`,
      `/api/v1/quickbooks/final-invoices/${intentId}/reject`,
      `/api/v1/quickbooks/final-invoices/${intentId}/reconcile`,
      "/api/v1/quickbooks/disconnect",
      "/api/v1/quickbooks/final-invoice-mappings",
    ]);
    expect(fetcher.mock.calls.map((call) => call[1]?.body)).toEqual([
      undefined,
      undefined,
      JSON.stringify({ return_path: "/accounting/quickbooks" }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 2, reason_code: "evidence_incomplete" }),
      JSON.stringify({ version: 3 }),
      JSON.stringify({ version: 4 }),
      JSON.stringify({
        roof_job_id: "JOB-0001",
        qbo_customer_id: "501",
        qbo_item_id: "601",
        qbo_tax_code_id: "701",
        qbo_terms_id: "801",
        jurisdiction: "CA-AB",
        tax_code: "GST",
        payment_terms_days: 30,
        correction_reason: null,
      }),
    ]);
    expect(
      fetcher.mock.calls.slice(2).map((call) => {
        const headers = new Headers(call[1]?.headers);
        return [headers.get("X-CSRF-Token"), headers.get("Idempotency-Key")];
      }),
    ).toEqual([
      ["csrf-qbo", "quickbooks:connect:test"],
      ["csrf-qbo", "quickbooks:approve:test"],
      ["csrf-qbo", "quickbooks:reject:test"],
      ["csrf-qbo", "quickbooks:reconcile:test"],
      ["csrf-qbo", "quickbooks:remove:test"],
      ["csrf-qbo", "quickbooks:mapping:test"],
    ]);
  });

  it("preserves a reconciliation-required connection read with its recorded version", async () => {
    const uncertainConnection = {
      version: 1 as const,
      state: "reconciliation_required" as const,
      connection_version: 4,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["refresh"] as const,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(uncertainConnection));

    await expect(loadQuickBooksConnection(fetcher)).resolves.toEqual(uncertainConnection);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/quickbooks/connection");
  });

  it("rejects malformed intent ids and reject reasons before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(loadQuickBooksFinalInvoice("../invoice", fetcher)).rejects.toThrow();
    await expect(
      rejectQuickBooksFinalInvoice(
        session,
        intentId,
        1,
        "free text" as never,
        "quickbooks:reject:test",
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("generates caller-stable action key prefixes", () => {
    expect(newQuickBooksActionKey("approve")).toMatch(/^quickbooks:approve:/);
  });
});
