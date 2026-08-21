import { describe, expect, it } from "vitest";

import {
  quickBooksConnectResponseSchema,
  quickBooksConnectionResponseSchema,
  quickBooksFinalInvoiceResponseSchema,
  quickBooksIntentStates,
} from "./quickbooks-contracts";
import { quickBooksFinalInvoiceFixture } from "./quickbooks-test-fixture";

const expectedOrigin = "https://os.example.invalid";
const redirectUri = `${expectedOrigin}/oauth/quickbooks/callback`;

function connectUrl(overrides: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    client_id: "client_123",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    state: "OpaqueState_123456789",
    ...overrides,
  });
  return `https://appcenter.intuit.com/connect/oauth2?${query.toString()}`;
}

function connectPayload(connect_url = connectUrl()) {
  return {
    version: 1,
    connect_url,
    return_path: "/accounting/quickbooks",
    expires_at: "2026-08-13T12:10:00.000Z",
    callback_origin: expectedOrigin,
    redirect_uri: redirectUri,
  };
}

describe("QuickBooks browser contracts", () => {
  it("accepts the exact zero-prior-billing final-invoice envelope", () => {
    const fixture = quickBooksFinalInvoiceFixture();
    expect(quickBooksFinalInvoiceResponseSchema.parse(fixture)).toEqual(fixture);
    expect(fixture.intent.citations.every((citation) => citation.source === "IronWrap")).toBe(true);
  });

  it("requires invoice_date and keeps due_date on or after it", () => {
    const missingInvoiceDate = structuredClone(quickBooksFinalInvoiceFixture()) as Record<
      string,
      unknown
    > & { intent: Record<string, unknown> };
    delete missingInvoiceDate.intent.invoice_date;
    const dueBeforeInvoice = structuredClone(quickBooksFinalInvoiceFixture());
    dueBeforeInvoice.intent.invoice_date = "2026-09-12";
    dueBeforeInvoice.intent.due_date = "2026-09-11";

    expect(quickBooksFinalInvoiceResponseSchema.safeParse(missingInvoiceDate).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(dueBeforeInvoice).success).toBe(false);
  });

  it("accepts only a state-bound connection settings read", () => {
    expect(
      quickBooksConnectionResponseSchema.safeParse({
        version: 1,
        state: "connected",
        connection_version: 4,
        realm_id: "123456789",
        last_connected_at: "2026-08-13T11:00:00.000Z",
        allowed_actions: ["remove_from_ironwrap", "refresh"],
      }).success,
    ).toBe(true);
    expect(
      quickBooksConnectionResponseSchema.safeParse({
        version: 1,
        state: "revoked",
        connection_version: 5,
        realm_id: "123456789",
        last_connected_at: "2026-08-13T11:00:00.000Z",
        allowed_actions: ["connect"],
      }).success,
    ).toBe(false);
  });

  it("preserves reconciliation-required connection state without allowing reconnect", () => {
    const uncertainConnection = {
      version: 1 as const,
      state: "reconciliation_required" as const,
      connection_version: 4,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["refresh"] as const,
    };
    expect(quickBooksConnectionResponseSchema.safeParse(uncertainConnection).success).toBe(true);
    expect(
      quickBooksConnectionResponseSchema.safeParse({
        ...uncertainConnection,
        allowed_actions: ["connect", "refresh"],
      }).success,
    ).toBe(false);

    const uncertainInvoice = quickBooksFinalInvoiceFixture();
    uncertainInvoice.connection = {
      state: "reconciliation_required",
      realm_id: null,
      last_connected_at: null,
    };
    uncertainInvoice.allowed_actions = ["refresh"];
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(uncertainInvoice).success).toBe(true);
    uncertainInvoice.allowed_actions = ["connect", "refresh"];
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(uncertainInvoice).success).toBe(false);
  });

  it.each([
    "customer_name",
    "customer_email",
    "customer_address",
    "memo",
    "description",
    "access_token",
  ])("rejects undeclared PII, free text, or secret field %s", (field) => {
    const payload = structuredClone(quickBooksFinalInvoiceFixture()) as unknown as {
      intent: Record<string, unknown>;
    };
    payload.intent[field] = "must-never-reach-the-browser";
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts exact prior billing and rejects malformed or mismatched remaining totals", () => {
    const priorBilling = structuredClone(quickBooksFinalInvoiceFixture());
    priorBilling.intent.amounts.already_invoiced = "500.00";
    const malformedPriorBilling = structuredClone(quickBooksFinalInvoiceFixture());
    malformedPriorBilling.intent.amounts.already_invoiced = "500";
    const lineMismatch = structuredClone(quickBooksFinalInvoiceFixture());
    lineMismatch.intent.lines[0]!.amount = "999.00";
    const balanceMismatch = structuredClone(quickBooksFinalInvoiceFixture());
    balanceMismatch.intent.amounts.final_balance = "1049.99";

    expect(quickBooksFinalInvoiceResponseSchema.safeParse(priorBilling).success).toBe(true);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(malformedPriorBilling).success).toBe(
      false,
    );
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(lineMismatch).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(balanceMismatch).success).toBe(false);
  });

  it("rejects malformed intent ids, hashes, money, and citation references", () => {
    const invalidId = structuredClone(quickBooksFinalInvoiceFixture());
    invalidId.intent.id = "../invoice";
    const invalidHash = structuredClone(quickBooksFinalInvoiceFixture());
    invalidHash.intent.basis.quote_hash = "A".repeat(64);
    const invalidMoney = structuredClone(quickBooksFinalInvoiceFixture());
    invalidMoney.intent.amounts.final_balance = "1,050.00";
    const overLimitMoney = structuredClone(quickBooksFinalInvoiceFixture());
    overLimitMoney.intent.amounts.final_balance = "1000000000.00";
    const invalidCitation = structuredClone(quickBooksFinalInvoiceFixture());
    invalidCitation.intent.citations[0]!.source_ref = "https://example.invalid/record";
    const traversalCitation = structuredClone(quickBooksFinalInvoiceFixture());
    traversalCitation.intent.citations[0] = {
      ...traversalCitation.intent.citations[0]!,
      source: "R2",
      source_ref: "R2:evidence/../private.json",
    };

    expect(quickBooksFinalInvoiceResponseSchema.safeParse(invalidId).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(invalidHash).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(invalidMoney).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(overLimitMoney).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(invalidCitation).success).toBe(false);
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(traversalCitation).success).toBe(false);
  });

  it("rejects impossible provider, submitted, blocked, and rejected evidence states", () => {
    const providerWithoutReadback = structuredClone(quickBooksFinalInvoiceFixture());
    providerWithoutReadback.intent.provider = {
      invoice_id: "10001",
      submitted_at: null,
      matched_at: null,
    };
    const submittedWithoutProvider = structuredClone(quickBooksFinalInvoiceFixture());
    submittedWithoutProvider.intent.state = "submitted";
    const blockedWithoutReason = structuredClone(quickBooksFinalInvoiceFixture());
    blockedWithoutReason.intent.state = "blocked";
    const rejectedWithoutReason = structuredClone(quickBooksFinalInvoiceFixture());
    rejectedWithoutReason.intent.state = "rejected";

    expect(quickBooksFinalInvoiceResponseSchema.safeParse(providerWithoutReadback).success).toBe(
      false,
    );
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(submittedWithoutProvider).success).toBe(
      false,
    );
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(blockedWithoutReason).success).toBe(
      false,
    );
    expect(quickBooksFinalInvoiceResponseSchema.safeParse(rejectedWithoutReason).success).toBe(
      false,
    );
  });

  it.each(quickBooksIntentStates)("accepts the bounded %s state", (state) => {
    const payload = structuredClone(quickBooksFinalInvoiceFixture());
    payload.intent.state = state;
    payload.allowed_actions = ["refresh"];
    if (state === "rejected") payload.intent.rejection_reason = "not_ready_to_invoice";
    if (state === "blocked") {
      payload.intent.blocker = {
        code: "commercial_policy_hold",
        next_step: "resolve_commercial_policy",
      };
    }
    if (state === "submitted" || state === "matched") {
      payload.intent.provider = {
        invoice_id: "10001",
        submitted_at: "2026-08-13T12:01:00.000Z",
        matched_at: state === "matched" ? "2026-08-13T12:02:00.000Z" : null,
      };
    }

    expect(quickBooksFinalInvoiceResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("allows only the exact current-origin Intuit OAuth authorization URL", () => {
    expect(
      quickBooksConnectResponseSchema(expectedOrigin).safeParse(connectPayload()).success,
    ).toBe(true);
  });

  it.each([
    "https://appcenter.intuit.com.evil.example/connect/oauth2",
    "https://intuit.example.invalid/connect/oauth2",
    "https://user:pass@appcenter.intuit.com/connect/oauth2",
    "https://appcenter.intuit.com:8443/connect/oauth2",
    "https://appcenter.intuit.com/connect/oauth2/continue",
  ])("rejects OAuth host, credential, port, or path drift: %s", (base) => {
    const url = `${base}?${connectUrl().split("?")[1]}`;
    expect(
      quickBooksConnectResponseSchema(expectedOrigin).safeParse(connectPayload(url)).success,
    ).toBe(false);
  });

  it("rejects fragments, extra or duplicate parameters, and wrong OAuth constants", () => {
    for (const url of [
      `${connectUrl()}#token=secret`,
      `${connectUrl()}&next=https%3A%2F%2Fevil.example`,
      `${connectUrl()}&state=OtherOpaqueState_1234`,
      connectUrl({ response_type: "token" }),
      connectUrl({ scope: "com.intuit.quickbooks.accounting openid" }),
      connectUrl({ client_id: "" }),
      connectUrl({ state: "short" }),
    ]) {
      expect(
        quickBooksConnectResponseSchema(expectedOrigin).safeParse(connectPayload(url)).success,
      ).toBe(false);
    }
  });

  it("rejects any callback origin or redirect mismatch, including ports and lookalikes", () => {
    for (const mutation of [
      { callback_origin: "https://evil.example" },
      { callback_origin: "https://os.example.invalid.evil.example" },
      { callback_origin: "https://os.example.invalid:8443" },
      { redirect_uri: "https://os.example.invalid/oauth/quickbooks/callback/extra" },
      { redirect_uri: "https://evil.example/oauth/quickbooks/callback" },
      {
        connect_url: connectUrl({ redirect_uri: "https://evil.example/oauth/quickbooks/callback" }),
      },
    ]) {
      expect(
        quickBooksConnectResponseSchema(expectedOrigin).safeParse({
          ...connectPayload(),
          ...mutation,
        }).success,
      ).toBe(false);
    }
  });

  it("permits HTTP only for the exact current localhost origin", () => {
    const localOrigin = "http://localhost:7100";
    const localRedirect = `${localOrigin}/oauth/quickbooks/callback`;
    const payload = {
      ...connectPayload(
        connectUrl({ redirect_uri: localRedirect }).replace(
          encodeURIComponent(redirectUri),
          encodeURIComponent(localRedirect),
        ),
      ),
      callback_origin: localOrigin,
      redirect_uri: localRedirect,
    };
    expect(quickBooksConnectResponseSchema(localOrigin).safeParse(payload).success).toBe(true);
    expect(
      quickBooksConnectResponseSchema("http://127.0.0.1:7100").safeParse({
        ...payload,
        callback_origin: "http://127.0.0.1:7100",
        redirect_uri: "http://127.0.0.1:7100/oauth/quickbooks/callback",
      }).success,
    ).toBe(false);
  });
});
