import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../../auth/session";
import { SessionProvider } from "../../auth/session-context";
import { JOB_ID, crews, entry, model, runwayJob, session } from "./gate-test-fixtures";
import { JobGatesPage } from "./job-gates-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const kinds = ["gates", "runway", "history"] as const;
type Kind = (typeof kinds)[number];
const prefix = {
  gates: "production-job-gates",
  runway: "production-runway",
  history: "job-gates-identity",
};
const pendingCleanup: (() => void)[] = [];
const clients: QueryClient[] = [];

afterEach(async () => {
  cleanup();
  pendingCleanup.splice(0).forEach((finish) => finish());
  await act(async () => {});
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

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

function payload(kind: Kind, revision = "old", jobId = JOB_ID) {
  if (kind === "gates") {
    const gates = model(revision === "old" ? "open" : "ended");
    return {
      ...gates,
      roof_job: jobId,
      gates: gates.gates.map((gate, gateIndex) => ({
        ...gate,
        roof_job: jobId,
        entries: gate.entries.map((entry, entryIndex) => ({
          ...entry,
          id: `pgc_${String(gateIndex * 100 + entryIndex).padStart(40, "0")}`,
        })),
      })),
    };
  }
  const envelope = {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-10-21T16:45:00.000Z",
    stale_fields: [],
    permissions: ["production:read"],
    allowed_actions: ["production.read"],
  };
  if (kind === "runway") {
    return {
      ...envelope,
      partial_sources: [],
      summary: {
        active_jobs: 1,
        blocked: 1,
        scheduled: 0,
        needs_assignment: 0,
        ready_for_review: 0,
        needs_verification: 0,
      },
      jobs: [{ ...runwayJob, id: jobId, job_number: `SYN-${revision}` }],
      crews,
    };
  }
  return {
    ...envelope,
    job: {
      id: jobId,
      roof_job_id: jobId,
      job_number: `SYN-${revision}`,
      brand: "Synthetic company",
      service_type: "Roofing",
      status: "Won",
      address: `Synthetic Street ${revision}, Synthetic City`,
      current_gate_state: null,
    },
    customer: { display_name: `Synthetic customer ${revision}`, phone: null },
    gates: [],
    field_measurements: [],
    field_measurements_more: false,
    proof: { items: [], next_cursor: null },
    openable: true,
    proof_unavailable: false,
  };
}

function response(kind: Kind, revision = "old", jobId = JOB_ID) {
  return Response.json(payload(kind, revision, jobId));
}

function legacyKey(kind: Kind, principal = session("production"), jobId = JOB_ID): QueryKey {
  const key = [prefix[kind], principal.tenant.id, principal.user.id];
  return kind === "runway" ? key : [...key, jobId];
}

function fixture(options: { seedLegacy?: boolean; step?: string } = {}) {
  const principal = session("production");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  if (options.seedLegacy) {
    for (const kind of kinds) client.setQueryData(legacyKey(kind), payload(kind));
  }
  const answers: Record<Kind, () => Response | Promise<Response>> = {
    gates: () => response("gates"),
    runway: () => response("runway"),
    history: () => response("history"),
  };
  const calls: { kind: Kind; path: string; signal: AbortSignal }[] = [];
  const commands: { path: string; body: unknown; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      if (init.method === "POST") {
        commands.push({
          path: input,
          body: JSON.parse(String(init.body)),
          headers: new Headers(init.headers),
        });
        return Response.json({
          entry: entry({ from_gate_version: 1 }),
          gate: {
            name: "gate:safety",
            gate: "Safety",
            roof_job: JOB_ID,
            state: "ready",
            version: 2,
          },
          replayed: false,
        });
      }
      const kind = input.endsWith("/gates")
        ? "gates"
        : input.endsWith("/history")
          ? "history"
          : "runway";
      calls.push({ kind, path: input, signal: init.signal as AbortSignal });
      return await answers[kind]();
    }),
  );
  const tree = (next = principal, jobId = JOB_ID) => (
    <QueryClientProvider client={client}>
      <SessionProvider session={next}>
        <JobGatesPage jobId={jobId} step={options.step} />
      </SessionProvider>
    </QueryClientProvider>
  );
  const mount = () => {
    const view = render(tree());
    return {
      ...view,
      changeSession: (next: AuthenticatedSession) => view.rerender(tree(next)),
      changeJob: (jobId: string) => view.rerender(tree(principal, jobId)),
    };
  };
  const activeQuery = (kind: Kind) => {
    const query = client
      .getQueryCache()
      .findAll({ queryKey: [prefix[kind]] })
      .find((query) => query.getObserversCount() > 0);
    expect(query, `mounted ${kind} query`).toBeDefined();
    return query!;
  };
  const refetch = (kind: Kind) =>
    client.refetchQueries({ queryKey: activeQuery(kind).queryKey, exact: true });
  return { client, principal, answers, calls, commands, mount, activeQuery, refetch };
}

async function expectHeld(kind: Kind) {
  await waitFor(() => {
    expect(screen.queryAllByText(/Synthetic customer old/)).toHaveLength(0);
    if (kind !== "history") {
      expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Clear Materials" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("link", { name: "Clear Safety" })).toBeVisible();
    }
  });
}

describe("office gate reads stay within their current authority", () => {
  it("keeps legacy callers' cached payloads separate and performs exactly three legacy reads", async () => {
    const rig = fixture({ seedLegacy: true });
    const pending = Object.fromEntries(
      kinds.map((kind) => [kind, deferred(response(kind, "fresh"))]),
    ) as Record<Kind, ReturnType<typeof deferred<Response>>>;
    for (const kind of kinds) rig.answers[kind] = () => pending[kind].promise;
    rig.mount();
    await waitFor(() => expect(rig.calls).toHaveLength(3));
    expect(screen.queryAllByText(/Synthetic customer old/)).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
    expect(rig.calls).toHaveLength(3);
    expect(rig.calls.map((call) => call.kind).sort()).toEqual([...kinds].sort());
    expect(rig.calls.every((call) => !call.path.includes("include_job_identity"))).toBe(true);
    for (const kind of kinds) {
      expect(rig.client.getQueryData(legacyKey(kind))).toEqual(payload(kind));
      expect(rig.activeQuery(kind).queryKey.at(-1)).toBe("office-gates-legacy-v1");
    }
    await act(async () => {
      for (const kind of kinds) pending[kind].resolve(response(kind, "fresh"));
    });
    expect(await screen.findAllByText(/Synthetic customer fresh/)).not.toHaveLength(0);
    expect(rig.client.getQueryCache().getAll()).toHaveLength(6);
  });

  it.each([
    ["tenant", (s: AuthenticatedSession) => ({ ...s, tenant: { ...s.tenant, id: "synthetic-b" } })],
    ["user", (s: AuthenticatedSession) => ({ ...s, user: { ...s.user, id: "synthetic-user-b" } })],
    ["role", (s: AuthenticatedSession) => ({ ...s, user: { ...s.user, role: "owner" as const } })],
    [
      "linked actor",
      (s: AuthenticatedSession) => ({
        ...s,
        user: { ...s.user, frappe_user_id: "synthetic-linked" },
      }),
    ],
    ["permissions", (s: AuthenticatedSession) => ({ ...s, permissions: [] })],
    ["allowed actions", (s: AuthenticatedSession) => ({ ...s, allowed_actions: [] })],
    ["session token", (s: AuthenticatedSession) => ({ ...s, csrf_token: "synthetic-token-b" })],
    [
      "session expiry",
      (s: AuthenticatedSession) => ({ ...s, session_expires_at: "2031-01-01T00:00:00.000Z" }),
    ],
  ] as const)("holds all old reads while a changed %s is checked", async (_name, change) => {
    const rig = fixture();
    const view = rig.mount();
    expect(await screen.findAllByText(/Synthetic customer old/)).not.toHaveLength(0);
    const oldKeys = kinds.map((kind) => rig.activeQuery(kind).queryKey);
    const pending = deferred(response("gates"));
    for (const kind of kinds) rig.answers[kind] = () => pending.promise;
    const next = change(rig.principal);
    view.changeSession(next);
    expect(screen.queryAllByText(/Synthetic customer old/)).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
    await waitFor(() => expect(rig.calls).toHaveLength(6));
    for (const [index, kind] of kinds.entries()) {
      expect(rig.activeQuery(kind).queryKey).not.toEqual(oldKeys[index]);
      const key = JSON.stringify(rig.activeQuery(kind).queryKey);
      expect(key).not.toContain(rig.principal.csrf_token);
      expect(key).not.toContain(next.csrf_token);
    }
    for (const [index, kind] of kinds.entries()) {
      expect(rig.client.getQueryData(oldKeys[index]!)).toEqual(payload(kind));
    }
  });

  it("aborts all superseded reads and ignores their reversed late answers", async () => {
    const rig = fixture();
    const old = Object.fromEntries(kinds.map((kind) => [kind, deferred(response(kind))])) as Record<
      Kind,
      ReturnType<typeof deferred<Response>>
    >;
    for (const kind of kinds) rig.answers[kind] = () => old[kind].promise;
    const view = rig.mount();
    await waitFor(() => expect(rig.calls).toHaveLength(3));
    const previous = [...rig.calls];
    for (const kind of kinds) rig.answers[kind] = () => response(kind, "fresh");
    view.changeSession({ ...rig.principal, csrf_token: "synthetic-new-login" });
    expect(previous.every((call) => call.signal.aborted)).toBe(true);
    expect(await screen.findAllByText(/Synthetic customer fresh/)).not.toHaveLength(0);
    await act(async () => {
      for (const kind of kinds) old[kind].resolve(response(kind));
    });
    expect(screen.queryAllByText(/Synthetic customer old/)).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Clear Materials" })).toBeVisible();
    view.unmount();
  });

  it("cancels old job reads before another job can supply gates or identity", async () => {
    const rig = fixture();
    const pending = deferred(response("gates"));
    rig.answers.gates = () => pending.promise;
    rig.answers.history = () => pending.promise;
    const view = rig.mount();
    await waitFor(() => expect(rig.calls).toHaveLength(3));
    const previous = rig.calls.filter((call) => call.kind !== "runway");
    for (const kind of kinds) rig.answers[kind] = () => response(kind, "fresh", "synthetic-job-b");
    view.changeJob("synthetic-job-b");
    expect(previous.every((call) => call.signal.aborted)).toBe(true);
    expect(await screen.findAllByText(/Synthetic customer fresh/)).not.toHaveLength(0);
    expect(rig.calls).toHaveLength(5);
  });

  it("starts a fresh authority scope on remount without reusing the prior mounted payload", async () => {
    const rig = fixture();
    const previous = rig.mount();
    expect(await screen.findAllByText(/Synthetic customer old/)).not.toHaveLength(0);
    const oldKeys = kinds.map((kind) => rig.activeQuery(kind).queryKey);
    previous.unmount();
    const pending = deferred(response("gates"));
    for (const kind of kinds) rig.answers[kind] = () => pending.promise;
    const current = rig.mount();
    expect(screen.queryAllByText(/Synthetic customer old/)).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
    await waitFor(() => expect(rig.calls).toHaveLength(6));
    const requests = rig.calls.slice(3);
    current.unmount();
    expect(requests.every((call) => call.signal.aborted)).toBe(true);
    for (const [index, kind] of kinds.entries()) {
      expect(rig.client.getQueryData(oldKeys[index]!)).toEqual(payload(kind));
    }
  });

  it("keeps the same scope when only the order of unchanged grants changes", async () => {
    const rig = fixture();
    rig.principal.permissions = ["production:read", "synthetic:read"];
    const view = rig.mount();
    expect(await screen.findAllByText(/Synthetic customer old/)).not.toHaveLength(0);
    const keys = kinds.map((kind) => rig.activeQuery(kind).queryKey);
    view.changeSession({
      ...rig.principal,
      permissions: [...rig.principal.permissions].reverse(),
      allowed_actions: [...rig.principal.allowed_actions].reverse(),
    });
    await act(async () => {});
    expect(rig.calls).toHaveLength(3);
    expect(kinds.map((kind) => rig.activeQuery(kind).queryKey)).toEqual(keys);
  });

  it.each(kinds)(
    "keeps an initial rejected %s read distinct from failed readback",
    async (kind) => {
      const rig = fixture();
      rig.answers[kind] = () => Response.json({ unexpected: true });
      rig.mount();
      await waitFor(() => expect(rig.activeQuery(kind).state.status).toBe("error"));
      expect(rig.activeQuery(kind).state.data).toBeUndefined();
      if (kind === "history") {
        expect(await screen.findAllByText("SYN-old")).not.toHaveLength(0);
        expect(screen.getByRole("link", { name: "Clear Safety" })).toBeVisible();
      } else {
        expect(
          await screen.findByText(
            kind === "gates"
              ? "The gates did not load. Nothing was changed."
              : "The production plan did not load. Load it again before changing a gate.",
          ),
        ).toBeVisible();
        expect(screen.queryByText(/A change may already be saved/)).not.toBeInTheDocument();
      }
      rig.answers[kind] = () => Response.json({ error: "synthetic_unavailable" }, { status: 503 });
      await act(() => rig.refetch(kind));
      expect(rig.activeQuery(kind).state.data).toBeUndefined();
      expect(screen.queryByText(/A change may already be saved/)).not.toBeInTheDocument();
      rig.answers[kind] = () => response(kind, "fresh");
      await act(() => rig.refetch(kind));
      expect(
        await screen.findByRole("link", {
          name: kind === "gates" ? "Clear Materials" : "Clear Safety",
        }),
      ).toBeVisible();
    },
  );

  it("holds a saved Safety command behind refused and failed readbacks without sending it twice", async () => {
    const rig = fixture({ step: "safety" });
    rig.mount();
    expect(
      await screen.findByRole("button", { name: "Clear Safety with this proof" }),
    ).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Hazard assessment"), "synthetic-hazard-41");
    await user.type(screen.getByLabelText("When it was done"), "2026-10-21T10:40");
    await user.click(screen.getByRole("radio", { name: "Permit not needed" }));
    await user.click(screen.getByRole("radio", { name: "Fall-protection plan" }));
    await user.type(
      screen.getByRole("textbox", { name: "Fall-protection plan" }),
      "synthetic-fall-plan-41",
    );
    rig.answers.gates = () => Response.json({ error: "synthetic_refusal" }, { status: 403 });
    await user.click(screen.getByRole("button", { name: "Clear Safety with this proof" }));
    expect(await screen.findByText(/The latest gates could not be checked/)).toBeVisible();
    expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear Safety with this proof" }),
    ).not.toBeInTheDocument();
    expect(rig.activeQuery("gates").state.data).toBeNull();
    expect(rig.commands).toHaveLength(1);
    expect(rig.commands[0]!.body).toMatchObject({
      basis: "person_attestation",
      expected_gate_version: 1,
    });
    expect(rig.commands[0]!.headers.get("x-csrf-token")).toBe(rig.principal.csrf_token);
    expect(rig.commands[0]!.headers.get("idempotency-key")).toMatch(
      /^production-gate-attestation:/,
    );
    rig.answers.gates = () => Response.json({ error: "synthetic_unavailable" }, { status: 503 });
    await user.click(screen.getByRole("button", { name: "Load the gates again" }));
    expect(await screen.findByText(/The latest gates could not be checked/)).toBeVisible();
    expect(rig.activeQuery("gates").state.data).toBeNull();
    expect(rig.commands).toHaveLength(1);
  });

  it.each(kinds)(
    "does not let a canceled %s body retire an accepted same-key replacement",
    async (kind) => {
      const rig = fixture();
      rig.mount();
      expect(await screen.findByRole("link", { name: "Clear Safety" })).toBeVisible();
      const body = deferred('{"unexpected":true}');
      const delayed = response(kind);
      vi.spyOn(delayed, "text").mockImplementation(() => body.promise);
      rig.answers[kind] = () => delayed;
      let superseded!: Promise<void>;
      await act(async () => {
        superseded = rig.refetch(kind);
      });
      await waitFor(() => expect(delayed.text).toHaveBeenCalledOnce());
      const oldSignal = rig.calls.at(-1)!.signal;
      rig.answers[kind] = () => response(kind, "fresh");
      await act(() => rig.refetch(kind));
      expect(oldSignal.aborted).toBe(true);
      expect(rig.activeQuery(kind).state.data).toEqual(payload(kind, "fresh"));
      await act(async () => {
        body.resolve('{"unexpected":true}');
        await superseded;
      });
      expect(rig.activeQuery(kind).state.data).toEqual(payload(kind, "fresh"));
      expect(
        await screen.findByRole("link", {
          name: kind === "gates" ? "Clear Materials" : "Clear Safety",
        }),
      ).toBeVisible();
    },
  );

  it.each(
    kinds.flatMap((kind) =>
      [401, 403, "invalid_response", "invalid_json"].map((failure) => [kind, failure] as const),
    ),
  )(
    "retires only the rejected %s payload after %s until a fresh accepted parse",
    async (kind, failure) => {
      const rig = fixture();
      rig.mount();
      expect(await screen.findAllByText(/Synthetic customer old/)).not.toHaveLength(0);
      const key = rig.activeQuery(kind).queryKey;
      rig.answers[kind] = () =>
        failure === "invalid_response"
          ? Response.json({ unexpected: true })
          : failure === "invalid_json"
            ? new Response('{"synthetic_incomplete":')
            : Response.json({ error: "synthetic_refusal" }, { status: failure as number });
      await act(() => rig.refetch(kind));
      expect(rig.client.getQueryData(key)).toBeNull();
      await expectHeld(kind);
      if (kind !== "history") {
        expect(screen.getByText(/A change may already be saved/)).toBeVisible();
        expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
      }
      for (const other of kinds.filter((other) => other !== kind)) {
        expect(rig.activeQuery(other).state.data).toEqual(payload(other));
      }
      for (const retry of ["network", "server", "parser", "json"] as const) {
        const pending = deferred(response(kind));
        rig.answers[kind] = () => pending.promise;
        let refresh!: Promise<void>;
        await act(async () => {
          refresh = rig.refetch(kind);
        });
        expect(rig.client.getQueryData(key)).toBeNull();
        await expectHeld(kind);
        if (retry === "network") {
          pending.reject(new TypeError("synthetic connection loss"));
        } else {
          pending.resolve(
            retry === "server"
              ? Response.json({ error: "synthetic_unavailable" }, { status: 503 })
              : retry === "json"
                ? new Response('{"synthetic_incomplete":')
                : Response.json({ unexpected: true }),
          );
        }
        await act(async () => {
          await refresh;
        });
        expect(rig.client.getQueryData(key)).toBeNull();
        await expectHeld(kind);
        if (kind !== "history") {
          expect(screen.getByText(/A change may already be saved/)).toBeVisible();
        }
      }
      rig.answers[kind] = () => response(kind, "fresh");
      await act(() => rig.refetch(kind));
      expect(rig.client.getQueryData(key)).toEqual(payload(kind, "fresh"));
      expect(
        await screen.findByRole("link", {
          name: kind === "gates" ? "Clear Materials" : "Clear Safety",
        }),
      ).toBeVisible();
      if (kind === "history")
        expect(screen.getAllByText(/Synthetic customer fresh/)).not.toHaveLength(0);
    },
  );

  it.each(["server", "response_lost"])(
    "keeps an ordinary %s transport refresh failure separate from payload retirement",
    async (failure) => {
      const rig = fixture();
      rig.mount();
      expect(await screen.findByRole("link", { name: "Clear Safety" })).toBeVisible();
      rig.answers.runway = () => {
        if (failure === "server")
          return Response.json({ error: "synthetic_unavailable" }, { status: 503 });
        const lost = response("runway");
        vi.spyOn(lost, "text").mockRejectedValue(new TypeError("synthetic lost response body"));
        return lost;
      };
      await act(() => rig.client.invalidateQueries({ queryKey: ["production-runway"] }));
      expect(rig.activeQuery("runway").state.data).toEqual(payload("runway"));
      expect(rig.activeQuery("runway").state.error).toMatchObject({
        code: failure === "server" ? "synthetic_unavailable" : "response_lost",
      });
      expect(
        await screen.findByText(/The latest production plan could not be checked/),
      ).toBeVisible();
      expect(screen.queryByRole("link", { name: "Clear Safety" })).not.toBeInTheDocument();
      rig.answers.runway = () => response("runway", "fresh");
      await act(() => rig.refetch("runway"));
      await waitFor(() => expect(screen.getByRole("link", { name: "Clear Safety" })).toBeVisible());
    },
  );
});
