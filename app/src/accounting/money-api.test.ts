import { describe, expect, it } from "vitest";

import {
  approveAccountingIntent,
  compensateAccountingIntent,
  loadAccountingExceptions,
  loadAccountingIntent,
  loadAccountingIntents,
  loadAccountingSummary,
  newAccountingActionKey,
  rejectAccountingIntent,
  resolveAccountingException,
} from "./money-api";
import {
  accountingSummaryResponseSchema,
  ageLabel,
  amountLabel,
  reasonLabel,
  remedyLabel,
} from "./money-contracts";
import {
  accountingSession,
  commandResponse,
  detailResponse,
  exceptionListResponse,
  summaryResponse,
} from "./money-fixtures";

function recordingFetch(body: unknown): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; method: string; headers: Headers; body: unknown }>;
} {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("money desk API client", () => {
  it("reads the desk from the money path space, never the QuickBooks connection one", async () => {
    const { fetcher, calls } = recordingFetch(summaryResponse());
    await loadAccountingSummary(fetcher);
    expect(calls[0]?.url).toBe("/api/v1/accounting/summary");
    expect(calls[0]?.method).toBe("GET");
  });

  it("puts every list filter on the query string, and omits the ones not asked for", async () => {
    const { fetcher, calls } = recordingFetch({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: [],
      intents: [],
    });
    await loadAccountingIntents({}, fetcher);
    expect(calls[0]?.url).toBe("/api/v1/accounting/intents");

    await loadAccountingIntents({ kind: "refund", state: "mismatch", job: "job-0001" }, fetcher);
    expect(calls[1]?.url).toBe(
      "/api/v1/accounting/intents?kind=refund&state=mismatch&job=job-0001",
    );
  });

  it("encodes an intent id into the path rather than trusting it", async () => {
    const { fetcher, calls } = recordingFetch(detailResponse());
    await loadAccountingIntent("acct-intent:job-0001:deposit_invoice", fetcher);
    expect(calls[0]?.url).toBe(
      "/api/v1/accounting/intents/acct-intent%3Ajob-0001%3Adeposit_invoice",
    );
  });

  it("refuses an id that is not the server's own shape before it reaches the wire", async () => {
    const { fetcher, calls } = recordingFetch(detailResponse());
    await expect(loadAccountingIntent("../../admin", fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("filters the exception queue by status", async () => {
    const { fetcher, calls } = recordingFetch(exceptionListResponse());
    await loadAccountingExceptions("open", fetcher);
    expect(calls[0]?.url).toBe("/api/v1/accounting/exceptions?status=open");
    await loadAccountingExceptions(undefined, fetcher);
    expect(calls[1]?.url).toBe("/api/v1/accounting/exceptions");
  });

  it("sends CSRF and an idempotency key on every command", async () => {
    const session = accountingSession();
    const { fetcher, calls } = recordingFetch(commandResponse());

    await approveAccountingIntent(
      session,
      "acct-intent:a",
      1,
      "accounting:approve:key0000",
      fetcher,
    );
    await rejectAccountingIntent(
      session,
      "acct-intent:a",
      1,
      "amount_disputed",
      "accounting:reject:key0000",
      fetcher,
    );
    await compensateAccountingIntent(
      session,
      "acct-intent:a",
      4,
      "credit_memo_issued",
      "accounting:comp:key0000",
      fetcher,
    );

    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.headers.get("X-CSRF-Token")).toBe("csrf");
      expect(call.headers.get("Idempotency-Key")).toMatch(/^accounting:/u);
    }
    expect(calls[0]?.body).toEqual({ version: 1 });
    expect(calls[1]?.body).toEqual({ version: 1, reason_code: "amount_disputed" });
    expect(calls[2]?.body).toEqual({ version: 4, remedy: "credit_memo_issued" });
  });

  it("omits the compensating effect entirely when there is none, rather than sending null", async () => {
    const session = accountingSession();
    const { fetcher, calls } = recordingFetch({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: [],
      exception: exceptionListResponse().exceptions[0],
    });

    await resolveAccountingException(
      session,
      "acct-exc-0001",
      "accepted_as_posted",
      null,
      "accounting:resolve:key0000",
      fetcher,
    );
    expect(calls[0]?.body).toEqual({ resolution_action: "accepted_as_posted" });

    await resolveAccountingException(
      session,
      "acct-exc-0001",
      "credit_memo_issued",
      "eff-1",
      "accounting:resolve:key0001",
      fetcher,
    );
    expect(calls[1]?.body).toEqual({
      resolution_action: "credit_memo_issued",
      compensating_effect_id: "eff-1",
    });
  });

  it("rejects a response that does not match the contract", async () => {
    const { fetcher } = recordingFetch({ version: 1, allowed_actions: [] });
    await expect(loadAccountingSummary(fetcher)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("mints a distinct key per action attempt", () => {
    const first = newAccountingActionKey("approve");
    const second = newAccountingActionKey("approve");
    expect(first).not.toBe(second);
    // The bus requires 16-160 of `[A-Za-z0-9._:-]`.
    expect(first).toMatch(/^[A-Za-z0-9._:-]{16,160}$/u);
  });
});

describe("money desk presentation", () => {
  it("parses the summary envelope the bus emits", () => {
    expect(accountingSummaryResponseSchema.safeParse(summaryResponse()).success).toBe(true);
  });

  it("reads an age the way a person would", () => {
    expect(ageLabel(30)).toBe("just now");
    expect(ageLabel(90)).toBe("1m");
    expect(ageLabel(3600)).toBe("1h");
    expect(ageLabel(60 * 60 * 72)).toBe("3d");
  });

  it("shows a reversal's direction with a minus sign, not a bracket", () => {
    expect(amountLabel("1260.00", "CAD")).toBe("CAD 1260.00");
    expect(amountLabel("-240.00", "CAD")).toBe("−CAD 240.00");
  });

  it("never labels a remedy as a deletion", () => {
    for (const remedy of [
      "void_provider_entity",
      "credit_memo_issued",
      "refund_issued",
      "adjusting_entry_posted",
      "accepted_as_posted",
      "superseded_by_new_intent",
    ] as const) {
      expect(remedyLabel(remedy)).not.toMatch(/delete/iu);
    }
  });

  it("falls back to a legible reason rather than a blank when a code is new", () => {
    expect(reasonLabel("provider_overpayment")).toBe("More was paid than was invoiced");
    expect(reasonLabel("some_future_code")).toBe("some future code");
  });
});
