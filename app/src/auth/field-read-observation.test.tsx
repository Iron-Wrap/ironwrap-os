import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthBoundary } from "./auth-boundary";
import { storeDeviceSecret } from "./device-credential";
import { fetchSession, persistAuthenticatedSession } from "./session";
import { useSession } from "./session-context";
import { sessionQueryKey } from "./session-query";
import {
  beginPrincipalContextChange,
  getPrincipalGeneration,
  getSessionReadObservation,
} from "./principal-context";
import type { FieldBootstrap } from "./field-bootstrap";
import { capturePrincipalEpoch, invalidatePrincipalEpoch } from "./principal-epoch";
import { resetDatabaseForTests } from "../storage/db";
import {
  useSavedPlanReadContext,
  captureSavedPlanReadContext,
} from "../field/saved-plan-read-context";
import { savedPlanSessionFixture } from "../field/saved-plan-test-fixture";

function Probe() {
  const session = useSession();
  const context = useSavedPlanReadContext(session);
  return (
    <>
      <p>Ordinary signed in: {session.user.display_name}</p>
      <output data-testid="field-current">{String(!context.blocked)}</output>
      <output data-testid="field-context">{context.id}</output>
    </>
  );
}
function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <AuthBoundary>
        <Probe />
      </AuthBoundary>
    </QueryClientProvider>,
  );
}
function bootstrap(session = savedPlanSessionFixture()) {
  return {
    version: 1,
    session,
    today: {
      version: 1,
      source_updated_at: session.source_updated_at,
      read_model_generated_at: session.read_model_generated_at,
      stale_fields: [],
      permissions: session.permissions,
      allowed_actions: session.allowed_actions,
      date: new Date(0).toISOString().slice(0, 10),
      jobs: [],
      work_objects: [],
    },
  };
}
const preloadWindow = window as Window & {
  __ironwrapFieldBootstrapResponse?: Promise<Response>;
  __ironwrapFieldBootstrapPreloadConsumed?: boolean;
  __ironwrapFieldBootstrapReadGeneration?: string | null;
  __ironwrapFieldBootstrapReadEpoch?: string | null;
};

describe("actual AuthBoundary and QueryClient field observation pipeline", () => {
  beforeEach(async () => {
    await storeDeviceSecret("a".repeat(43));
    window.history.replaceState({}, "", "/today");
  });
  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete preloadWindow.__ironwrapFieldBootstrapResponse;
    delete preloadWindow.__ironwrapFieldBootstrapPreloadConsumed;
    delete preloadWindow.__ironwrapFieldBootstrapReadGeneration;
    delete preloadWindow.__ironwrapFieldBootstrapReadEpoch;
    window.history.replaceState({}, "", "/");
  });

  it("keeps a fresh positive observation when structural sharing reuses the previous session object", async () => {
    const payload = bootstrap();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload)),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(client);
    await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("true"));
    const first = client.getQueryData<FieldBootstrap>(sessionQueryKey)!;
    let identity = screen.getByTestId("field-context").textContent;
    for (const transition of [false, true]) {
      if (transition)
        act(() => {
          const changed = beginPrincipalContextChange();
          changed();
        });
      await act(async () => {
        await client.refetchQueries({ queryKey: sessionQueryKey });
      });
      const refreshed = client.getQueryData<FieldBootstrap>(sessionQueryKey)!;
      expect(refreshed.session).toBe(first.session);
      expect(refreshed.field_read_observation?.id).not.toBe(first.field_read_observation?.id);
      await waitFor(() =>
        expect(screen.getByTestId("field-context").textContent).not.toBe(identity),
      );
      await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("true"));
      identity = screen.getByTestId("field-context").textContent;
    }
  });

  it.each(["verified", "crossed", "missing", "missing-epoch", "epoch-crossed"])(
    "keeps the %s head-preload provenance through the actual AuthBoundary query",
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      preloadWindow.__ironwrapFieldBootstrapResponse = Promise.resolve(Response.json(bootstrap()));
      delete preloadWindow.__ironwrapFieldBootstrapPreloadConsumed;
      if (mode !== "missing")
        preloadWindow.__ironwrapFieldBootstrapReadGeneration = getPrincipalGeneration();
      if (mode !== "missing" && mode !== "missing-epoch")
        preloadWindow.__ironwrapFieldBootstrapReadEpoch = (await capturePrincipalEpoch()) ?? null;
      if (mode === "epoch-crossed") await invalidatePrincipalEpoch();
      if (mode === "crossed") {
        const changed = beginPrincipalContextChange();
        changed();
      }
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      mount(client);
      await screen.findByText("Ordinary signed in: Synthetic crew");
      await waitFor(() =>
        expect(screen.getByTestId("field-current")).toHaveTextContent(String(mode === "verified")),
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("keeps a crossed bootstrap read unverified through the real query function and structural sharing", async () => {
    const payload = bootstrap();
    let calls = 0;
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      ++calls === 1
        ? Response.json(payload)
        : await new Promise((resolve) => {
            finish = resolve;
          }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(client);
    await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("true"));
    const first = client.getQueryData<FieldBootstrap>(sessionQueryKey)!;
    let pending: Promise<void>;
    act(() => {
      pending = client.refetchQueries({ queryKey: sessionQueryKey });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => {
      const changed = beginPrincipalContextChange();
      changed();
    });
    await act(async () => {
      finish(Response.json(payload));
      await pending!;
    });
    expect(client.getQueryData<FieldBootstrap>(sessionQueryKey)!.session).toBe(first.session);
    await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("false"));
    expect(screen.getByText("Ordinary signed in: Synthetic crew")).toBeVisible();
  });

  it("does not inherit an old WeakMap tag when a cache writer supplies an untagged shared session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json(bootstrap())),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(client);
    await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("true"));
    const first = client.getQueryData<FieldBootstrap>(sessionQueryKey)!;
    act(() => {
      client.setQueryData(sessionQueryKey, {
        session: structuredClone(first.session),
        today: first.today,
      });
    });
    const untagged = client.getQueryData<FieldBootstrap>(sessionQueryKey)!;
    expect(untagged.session).toBe(first.session);
    await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("false"));
    if (!untagged.session.authenticated) throw new Error("Expected unchanged ordinary sign-in");
    await expect(captureSavedPlanReadContext(untagged.session)).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });

  it("does not retag a crossed ordinary session response as current inside AuthBoundary", async () => {
    window.history.replaceState({}, "", "/jobs/JOB-SYNTHETIC/plan");
    const source = savedPlanSessionFixture();
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(client);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    act(() => {
      const changed = beginPrincipalContextChange();
      changed();
    });
    await act(async () => {
      finish(Response.json(source));
    });
    await screen.findByText("Ordinary signed in: Synthetic crew");
    expect(screen.getByTestId("field-current")).toHaveTextContent("false");
  });

  it("restores a verified saved observation across a cloned offline query wrapper", async () => {
    window.history.replaceState({}, "", "/jobs/JOB-SYNTHETIC/plan");
    const source = savedPlanSessionFixture();
    await fetchSession(async () => Response.json(source));
    const offline = await fetchSession(async () => {
      throw new TypeError("Synthetic offline");
    });
    if (!offline.authenticated) throw new Error("Expected the ordinary saved session");
    const observation = getSessionReadObservation(offline);
    expect(observation?.source).toBe("offline");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      sessionQueryKey,
      structuredClone({ session: offline, field_read_observation: observation }),
    );
    mount(client);
    await waitFor(() => expect(screen.getByTestId("field-current")).toHaveTextContent("true"));
  });

  it.each(["untagged", "changed-generation"])(
    "keeps a %s restored snapshot unverified without changing ordinary offline sign-in",
    async (kind) => {
      window.history.replaceState({}, "", "/jobs/JOB-SYNTHETIC/plan");
      const source = savedPlanSessionFixture();
      if (kind === "untagged") await persistAuthenticatedSession(source);
      else {
        await fetchSession(async () => Response.json(source));
        const changed = beginPrincipalContextChange();
        changed();
      }
      const offline = await fetchSession(async () => {
        throw new TypeError("Synthetic offline");
      });
      expect(offline.authenticated).toBe(true);
      if (!offline.authenticated) throw new Error("Expected unchanged ordinary offline sign-in");
      expect(getSessionReadObservation(offline)).toBeUndefined();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(sessionQueryKey, structuredClone({ session: offline }));
      mount(client);
      await screen.findByText("Ordinary signed in: Synthetic crew");
      expect(screen.getByTestId("field-current")).toHaveTextContent("false");
    },
  );
});
