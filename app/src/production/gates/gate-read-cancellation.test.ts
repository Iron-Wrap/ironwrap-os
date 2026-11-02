import { describe, expect, it, vi } from "vitest";

import { loadProductionRunway } from "../production-api";
import { loadJobGates, loadSignedCopyQueue } from "./gate-api";
import { JOB_ID } from "./gate-test-fixtures";

const reads: {
  name: string;
  path: string;
  load: (fetcher: typeof fetch, signal: AbortSignal) => Promise<unknown>;
}[] = [
  {
    name: "gates",
    path: `/api/v1/production/jobs/${JOB_ID}/gates`,
    load: (fetcher, signal) => loadJobGates(JOB_ID, fetcher, signal),
  },
  { name: "runway", path: "/api/v1/production", load: loadProductionRunway },
  {
    name: "signed-copy queue",
    path: "/api/v1/production/cancellation-window/signed-copy-missing",
    load: loadSignedCopyQueue,
  },
];

describe("office read adapter cancellation", () => {
  it.each(reads)(
    "keeps an aborted $name response body aborted, rather than schema-invalid",
    async ({ path, load }) => {
      const controller = new AbortController();
      let bodyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      const fetcher = vi.fn<typeof fetch>(
        async (_path, init) =>
          new Response(
            new ReadableStream({
              start(body) {
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    body.error(new DOMException("synthetic office cancellation", "AbortError"));
                  },
                  { once: true },
                );
                bodyStarted();
              },
            }),
            { status: 200 },
          ),
      );
      const request = load(fetcher, controller.signal);
      const rejected = expect(request).rejects.toMatchObject({ status: 200, code: "aborted" });
      await started;
      controller.abort("synthetic superseded office read");
      await rejected;
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        }),
      );
      expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    },
  );
});
