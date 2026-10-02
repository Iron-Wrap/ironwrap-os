import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyOutboxSummary, getOutboxSummary, subscribeOutboxChanges } from "./outbox-store";
import { useOutboxSummary } from "./use-outbox";

vi.mock("./outbox-store", async (original) => ({
  ...(await original<typeof import("./outbox-store")>()),
  getOutboxSummary: vi.fn(),
  subscribeOutboxChanges: vi.fn(() => () => {}),
}));

const principal = { tenantId: "tenant-a", userId: "crew-a" };
type Summary = Awaited<ReturnType<typeof getOutboxSummary>>;
function pendingRead() {
  let resolve!: (value: Summary) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Summary>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("saved work status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not call an unread or failed local store empty", async () => {
    const read = pendingRead();
    vi.mocked(getOutboxSummary).mockReturnValue(read.promise);
    const { result } = renderHook(() => useOutboxSummary(principal));
    expect(result.current.readState).toBe("checking");
    await act(async () => read.reject(new Error("storage unavailable")));
    expect(result.current.readState).toBe("error");
  });

  it("waits for the new user's read without exposing the previous user's counts", async () => {
    vi.mocked(getOutboxSummary).mockResolvedValueOnce({ ...emptyOutboxSummary(), pending: 7 });
    const next = pendingRead();
    vi.mocked(getOutboxSummary).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(useOutboxSummary, { initialProps: principal });
    await waitFor(() => expect(result.current.pending).toBe(7));
    rerender({ ...principal, userId: "crew-b" });
    expect(result.current.readState).toBe("checking");
    expect(result.current.pending).toBe(0);
    await act(async () => next.resolve({ ...emptyOutboxSummary(), pending: 2 }));
    expect(result.current.pending).toBe(2);
    expect(result.current.readState).toBe("ready");
  });

  it("ignores an older read that finishes after a saved-work notification", async () => {
    const older = pendingRead();
    const newer = pendingRead();
    vi.mocked(getOutboxSummary)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useOutboxSummary(principal));
    act(() => vi.mocked(subscribeOutboxChanges).mock.calls[0]![0]());
    await act(async () => newer.resolve({ ...emptyOutboxSummary(), pending: 1 }));
    await act(async () => older.resolve(emptyOutboxSummary()));
    expect(result.current.pending).toBe(1);
  });
});
