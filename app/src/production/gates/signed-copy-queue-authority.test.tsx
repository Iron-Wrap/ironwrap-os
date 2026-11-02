import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../../auth/session";
import { SessionProvider } from "../../auth/session-context";
import { queue, session } from "./gate-test-fixtures";
import { SignedCopyQueuePage } from "./signed-copy-queue-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const prefix = "production-signed-copy-missing";
const clients: QueryClient[] = [];
const pendingCleanup: (() => void)[] = [];

afterEach(async () => {
  cleanup();
  pendingCleanup.splice(0).forEach((finish) => finish());
  await act(async () => {});
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

function payload(revision = "old") {
  return {
    ...queue,
    count: 1,
    counts: { window_unknown: 1, signed_copy_unconfirmed: 0 },
    jobs: [
      {
        ...queue.jobs[0]!,
        customer_display_name: `Synthetic queue customer ${revision}`,
        address_line1: `Synthetic queue street ${revision}`,
      },
    ],
  };
}

function response(revision = "old") {
  return Response.json(payload(revision));
}

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  pendingCleanup.push(() => resolve(fallback));
  return { promise, resolve, reject };
}

function fixture(seedLegacy = false) {
  const principal = session("owner");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const legacyKey = [prefix, principal.tenant.id, principal.user.id];
  if (seedLegacy) client.setQueryData(legacyKey, payload());
  const server = { answer: (): Response | Promise<Response> => response() };
  const calls: { path: string; signal: AbortSignal }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, signal: init.signal as AbortSignal });
      return await server.answer();
    }),
  );
  const tree = (next = principal) => (
    <QueryClientProvider client={client}>
      <SessionProvider session={next}>
        <SignedCopyQueuePage />
      </SessionProvider>
    </QueryClientProvider>
  );
  const mount = () => {
    const view = render(tree());
    return { ...view, changeSession: (next: AuthenticatedSession) => view.rerender(tree(next)) };
  };
  const query = () =>
    client
      .getQueryCache()
      .findAll({ queryKey: [prefix] })
      .find((query) => query.getObserversCount() > 0)!;
  const refetch = () => client.refetchQueries({ queryKey: query().queryKey, exact: true });
  return { principal, client, legacyKey, calls, server, mount, query, refetch };
}

async function expectHeld() {
  await waitFor(() => {
    expect(screen.queryAllByText(/Synthetic queue customer old/)).toHaveLength(0);
    expect(
      screen.queryByRole("link", { name: /Add the signed-copy time/ }),
    ).not.toBeInTheDocument();
  });
}

describe("signed-copy queue authority and rejected payloads", () => {
  it("keeps unrelated legacy queue data separate and reads the unchanged legacy endpoint once", async () => {
    const rig = fixture(true);
    const pending = deferred(response("fresh"));
    rig.server.answer = () => pending.promise;
    rig.mount();
    await waitFor(() => expect(rig.calls).toHaveLength(1));
    expect(screen.queryAllByText(/Synthetic queue customer old/)).toHaveLength(0);
    await expectHeld();
    expect(rig.query().queryKey.at(-1)).toBe("office-gates-legacy-v1");
    expect(rig.client.getQueryData(rig.legacyKey)).toEqual(payload());
    expect(rig.calls[0]!.path).toBe("/api/v1/production/cancellation-window/signed-copy-missing");
    await act(async () => {
      pending.resolve(response("fresh"));
    });
    expect(
      await screen.findByRole("link", { name: /Synthetic queue customer fresh/ }),
    ).toBeVisible();
  });

  it.each([
    ["role", (s: AuthenticatedSession) => ({ ...s, user: { ...s.user, role: "ops" as const } })],
    ["permissions", (s: AuthenticatedSession) => ({ ...s, permissions: [] })],
    ["allowed actions", (s: AuthenticatedSession) => ({ ...s, allowed_actions: [] })],
    ["session", (s: AuthenticatedSession) => ({ ...s, csrf_token: "synthetic-queue-new-login" })],
  ] as const)("holds old queue rows while changed %s is checked", async (_name, change) => {
    const rig = fixture();
    const view = rig.mount();
    expect(await screen.findByRole("link", { name: /Synthetic queue customer old/ })).toBeVisible();
    const oldKey = rig.query().queryKey;
    const pending = deferred(response("fresh"));
    rig.server.answer = () => pending.promise;
    view.changeSession(change(rig.principal));
    expect(screen.queryAllByText(/Synthetic queue customer old/)).toHaveLength(0);
    await expectHeld();
    await waitFor(() => expect(rig.calls).toHaveLength(2));
    expect(rig.query().queryKey).not.toEqual(oldKey);
    expect(JSON.stringify(rig.query().queryKey)).not.toContain(rig.principal.csrf_token);
    expect(JSON.stringify(rig.query().queryKey)).not.toContain("synthetic-queue-new-login");
    expect(rig.client.getQueryData(oldKey)).toEqual(payload());
    await act(async () => {
      pending.resolve(response("fresh"));
    });
    expect(
      await screen.findByRole("link", { name: /Synthetic queue customer fresh/ }),
    ).toBeVisible();
  });

  it.each([401, 403, "invalid_response", "invalid_json"])(
    "retires the exact queue after %s through unsuccessful retries",
    async (failure) => {
      const rig = fixture();
      rig.mount();
      expect(
        await screen.findByRole("link", { name: /Synthetic queue customer old/ }),
      ).toBeVisible();
      rig.server.answer = () =>
        failure === "invalid_response"
          ? Response.json({ unexpected: true })
          : failure === "invalid_json"
            ? new Response('{"synthetic_incomplete":')
            : Response.json({ error: "synthetic_refusal" }, { status: failure as number });
      await act(() => rig.refetch());
      expect(rig.query().state.data).toBeNull();
      await expectHeld();
      expect(
        screen.getByText("The latest list could not be checked. Reload it before choosing a job."),
      ).toBeVisible();
      for (const failure of ["network", "server", "parser", "json"]) {
        const pending = deferred(response());
        rig.server.answer = () => pending.promise;
        let retry!: Promise<void>;
        await act(async () => {
          retry = rig.refetch();
        });
        expect(rig.query().state.data).toBeNull();
        await expectHeld();
        if (failure === "network") pending.reject(new TypeError("synthetic queue network loss"));
        else
          pending.resolve(
            failure === "server"
              ? Response.json({ error: "synthetic_unavailable" }, { status: 503 })
              : failure === "json"
                ? new Response('{"synthetic_incomplete":')
                : Response.json({ unexpected: true }),
          );
        await act(async () => {
          await retry;
        });
        expect(rig.query().state.data).toBeNull();
        await expectHeld();
        expect(
          screen.getByText(
            "The latest list could not be checked. Reload it before choosing a job.",
          ),
        ).toBeVisible();
      }
      rig.server.answer = () => response("fresh");
      await act(() => rig.refetch());
      expect(
        await screen.findByRole("link", { name: /Synthetic queue customer fresh/ }),
      ).toBeVisible();
      expect(rig.query().state.data).toEqual(payload("fresh"));
    },
  );

  it("aborts a superseded queue body without retiring a newer accepted same-key result", async () => {
    const rig = fixture();
    rig.mount();
    expect(await screen.findByRole("link", { name: /Synthetic queue customer old/ })).toBeVisible();
    const body = deferred('{"unexpected":true}');
    const old = response();
    vi.spyOn(old, "text").mockImplementation(() => body.promise);
    rig.server.answer = () => old;
    let superseded!: Promise<void>;
    await act(async () => {
      superseded = rig.refetch();
    });
    await waitFor(() => expect(old.text).toHaveBeenCalledOnce());
    const signal = rig.calls.at(-1)!.signal;
    rig.server.answer = () => response("fresh");
    await act(() => rig.refetch());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      body.resolve('{"unexpected":true}');
      await superseded;
    });
    expect(rig.query().state.data).toEqual(payload("fresh"));
    expect(
      await screen.findByRole("link", { name: /Synthetic queue customer fresh/ }),
    ).toBeVisible();
  });

  it.each(["server", "response_lost"])(
    "retains the ordinary authorized %s transport cache while holding queue controls",
    async (failure) => {
      const rig = fixture();
      rig.mount();
      expect(
        await screen.findByRole("link", { name: /Synthetic queue customer old/ }),
      ).toBeVisible();
      rig.server.answer = () => {
        if (failure === "server")
          return Response.json({ error: "synthetic_unavailable" }, { status: 503 });
        const lost = response();
        vi.spyOn(lost, "text").mockRejectedValue(new TypeError("synthetic lost queue body"));
        return lost;
      };
      await act(() => rig.refetch());
      await expectHeld();
      expect(rig.query().state.data).toEqual(payload());
      expect(rig.query().state.error).toMatchObject({
        code: failure === "server" ? "synthetic_unavailable" : "response_lost",
      });
      expect(
        screen.getByText("The latest list could not be checked. Reload it before choosing a job."),
      ).toBeVisible();
    },
  );

  it("keeps first-load failure distinct and denies a role that cannot record signed-copy time", async () => {
    const rig = fixture();
    rig.server.answer = () => Response.json({ unexpected: true });
    const view = rig.mount();
    expect(await screen.findByText("The list did not load. Nothing was changed.")).toBeVisible();
    expect(rig.query().state.data).toBeUndefined();
    view.changeSession({ ...rig.principal, user: { ...rig.principal.user, role: "production" } });
    expect(
      await screen.findByText("Only the Owner or Operations can see this list."),
    ).toBeVisible();
    expect(rig.calls).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /signed-copy time/ })).not.toBeInTheDocument();
  });
});
