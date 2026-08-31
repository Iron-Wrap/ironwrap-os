import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadCapabilitySignal } from "./capability-api";
import { capabilityCopy } from "./capability-copy";
import {
  capabilitySignalResponseSchema,
  officeDetail,
  presentableCapabilities,
} from "./capability-contracts";
import {
  capabilityHasNotice,
  capabilityPreventsUse,
  useCapability,
  type CapabilityRead,
} from "./capability-signal";
import {
  capabilitySignal,
  officeCapability,
  rejectedOfficeCapability,
  scopedCapability,
  unconfiguredOfficeCapability,
} from "./capability-test-fixture";
import { CapabilityUnavailable } from "./capability-unavailable";

vi.mock("./capability-api", () => ({ loadCapabilitySignal: vi.fn() }));

function session(
  role: AuthenticatedSession["user"]["role"],
  overrides: Partial<AuthenticatedSession> = {},
): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: `appu_${role}`,
      email: `${role}@example.invalid`,
      display_name: "Acceptance User",
      role,
      frappe_user_id: null,
    },
    tenant: {
      id: "ironwrap",
      name: "IronWrap Exteriors",
      brand: "IronWrap Exteriors",
      locale: "en-CA",
      time_zone: "America/Edmonton",
      currency: "CAD",
    },
    permissions: [],
    allowed_actions: [],
    csrf_token: "csrf",
    session_expires_at: "2036-08-31T00:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-08-31T00:00:00.000Z",
    stale_fields: [],
    ...overrides,
  };
}

function Probe({ id }: { id: string }) {
  const read = useCapability(id);
  return (
    <div>
      <output data-testid="status">{read.status}</output>
      <output data-testid="state">
        {read.status === "known" ? read.capability.state : "none"}
      </output>
      <output data-testid="prevents">{String(capabilityPreventsUse(read))}</output>
      <CapabilityUnavailable read={read} />
    </div>
  );
}

function renderProbe(id: string, current: AuthenticatedSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={current}>
        <Probe id={id} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("capability signal contract", () => {
  it("refuses a payload that claims proof, because this read model never reports proof", () => {
    const claimed = {
      ...capabilitySignal("owner", []),
      proof_claimed: true,
    };
    expect(capabilitySignalResponseSchema.safeParse(claimed).success).toBe(false);
  });

  it("refuses a state outside the six, rather than guessing what a seventh means", () => {
    const invented = capabilitySignal("owner", [
      { ...scopedCapability("newo", "Newo voice reception"), state: "degraded" } as never,
    ]);
    expect(capabilitySignalResponseSchema.safeParse(invented).success).toBe(false);
  });

  it("accepts a capability id and reason it has never seen, so a new server capability cannot blank a screen", () => {
    const future = capabilitySignal("owner", [
      scopedCapability("weather_intake", "Weather intake", { reason: "some_new_reason" }),
    ]);
    const parsed = capabilitySignalResponseSchema.safeParse(future);
    expect(parsed.success).toBe(true);
  });

  it("keeps the office detail on an office payload and never invents it on a scoped one", () => {
    const office = capabilitySignalResponseSchema.parse(
      capabilitySignal("owner", [
        unconfiguredOfficeCapability("proposal_template", "Proposal document template", [
          "PROPOSAL_TEMPLATE_DOC_ID",
        ]),
      ]),
    );
    const scoped = capabilitySignalResponseSchema.parse(
      capabilitySignal("sales", [
        scopedCapability("proposal_template", "Proposal document template", {
          state: "unconfigured",
          reason: "configuration_incomplete",
        }),
      ]),
    );

    expect(officeDetail(office.capabilities[0]!)?.missing_configuration).toEqual([
      "PROPOSAL_TEMPLATE_DOC_ID",
    ]);
    expect(officeDetail(scoped.capabilities[0]!)).toBeUndefined();
  });

  it("never presents an absent capability", () => {
    const model = capabilitySignal("owner", [
      officeCapability("facet_design_ingest_v1", "Facet v1 design ingest", {
        presence: "absent",
        state: "absent",
        reason: "no_source_consumer",
      }),
      officeCapability("newo", "Newo voice reception"),
    ]);
    expect(presentableCapabilities(model).map((capability) => capability.id)).toEqual(["newo"]);
  });
});

describe("capability copy", () => {
  it("gives an operator two different jobs for incomplete and rejected configuration", () => {
    const incomplete = capabilityCopy(
      unconfiguredOfficeCapability("facet_launch", "Facet design launch", [
        "FACET_LAUNCH_HMAC_KEY",
      ]),
      "owner",
    );
    const rejected = capabilityCopy(
      rejectedOfficeCapability("facet_launch", "Facet design launch"),
      "owner",
    );

    expect(incomplete?.nextAction).toContain("FACET_LAUNCH_HMAC_KEY");
    // Pointing at a missing binding when there is none sends an operator hunting for a blank that
    // does not exist, so the rejected copy says the opposite in words.
    expect(rejected?.nextAction).toContain("no empty setting to fill in");
    expect(rejected?.nextAction).not.toContain("FACET_LAUNCH_HMAC_KEY");
    expect(rejected?.title).not.toEqual(incomplete?.title);
  });

  it("never names a binding to a role that does not receive one", () => {
    const copy = capabilityCopy(
      scopedCapability("facet_launch", "Facet design launch", {
        state: "unconfigured",
        reason: "configuration_incomplete",
      }),
      "sales",
    );
    expect(copy?.nextAction).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    expect(copy?.personPath).toContain("owner or operations lead");
  });

  it("says nothing for the two states that are not an unavailability to explain", () => {
    expect(
      capabilityCopy(
        officeCapability("effect_runtime", "Effect ledger", { state: "available" }),
        "owner",
      ),
    ).toBeUndefined();
    expect(
      capabilityCopy(
        officeCapability("facet_design_ingest_v1", "Facet v1 design ingest", { state: "absent" }),
        "owner",
      ),
    ).toBeUndefined();
  });

  it("reports an unknown state as neither working nor broken", () => {
    const copy = capabilityCopy(
      officeCapability("quickbooks_oauth", "QuickBooks connection", {
        state: "unknown",
        reason: "configuration_indeterminate",
        readback_required: true,
      }),
      "owner",
    );
    expect(copy?.message).toContain("neither working nor broken");
    expect(copy?.nextAction).toContain("read the deployment configuration back");
  });
});

describe("useCapability", () => {
  beforeEach(() => {
    vi.mocked(loadCapabilitySignal).mockResolvedValue(
      capabilitySignal("owner", [officeCapability("newo", "Newo voice reception")]),
    );
  });

  it("reads a capability the role receives", async () => {
    renderProbe("newo", session("owner"));

    expect(await screen.findByText("known")).toBeVisible();
    expect(screen.getByTestId("state")).toHaveTextContent("off");
    expect(screen.getByTestId("prevents")).toHaveTextContent("true");
  });

  it("calls a capability the role does not receive 'not visible', never 'off'", async () => {
    renderProbe("quickbooks_oauth", session("owner"));

    expect(await screen.findByText("not_visible")).toBeVisible();
    expect(screen.getByTestId("prevents")).toHaveTextContent("false");
    // Nothing is claimed about a capability this role was never told about.
    expect(screen.queryByText("Turned off")).toBeNull();
  });

  it("does not read the signal at all on a saved offline session, and claims nothing from cache", async () => {
    renderProbe("newo", session("owner", { csrf_token: "offline-session-no-csrf" }));

    expect(await screen.findByText("unreadable")).toBeVisible();
    expect(loadCapabilitySignal).not.toHaveBeenCalled();
    expect(screen.queryByText("Turned off")).toBeNull();
    // A configuration condition is never presented as an offline one, and the reverse holds too:
    // being offline is never presented as a capability being switched off.
    expect(screen.getByTestId("prevents")).toHaveTextContent("false");
  });

  it("treats a failed read as unreadable rather than as evidence of anything", async () => {
    vi.mocked(loadCapabilitySignal).mockRejectedValue(new Error("boom"));
    renderProbe("newo", session("owner"));

    expect(await screen.findByText("unreadable")).toBeVisible();
    expect(screen.getByTestId("prevents")).toHaveTextContent("false");
  });
});

describe("capabilityPreventsUse", () => {
  const known = (state: string): CapabilityRead => ({
    status: "known",
    capability: officeCapability("newo", "Newo voice reception", { state } as never),
  });

  it("stops a control only where using it would actually fail", () => {
    expect(capabilityPreventsUse(known("off"))).toBe(true);
    expect(capabilityPreventsUse(known("unconfigured"))).toBe(true);
    expect(capabilityPreventsUse(known("dependency_blocked"))).toBe(true);
    // Not `unknown`: a state IronWrap could not determine is not evidence that the action fails,
    // and disabling on it would be the same guess in the other direction.
    expect(capabilityPreventsUse(known("unknown"))).toBe(false);
    expect(capabilityPreventsUse(known("available"))).toBe(false);
    expect(capabilityPreventsUse({ status: "unreadable", offline: false })).toBe(false);
    expect(capabilityPreventsUse({ status: "not_visible" })).toBe(false);
  });

  it("still explains an unknown state even though it does not stop the control", () => {
    expect(capabilityHasNotice(known("unknown"))).toBe(true);
    expect(capabilityHasNotice(known("available"))).toBe(false);
    expect(capabilityHasNotice(known("absent"))).toBe(false);
  });
});

describe("CapabilityUnavailable", () => {
  it("offers no retry, because no retry can switch a capability on", async () => {
    vi.mocked(loadCapabilitySignal).mockResolvedValue(
      capabilitySignal("owner", [officeCapability("newo", "Newo voice reception")]),
    );
    renderProbe("newo", session("owner"));

    expect(
      await screen.findByRole("heading", { name: "Newo voice reception is turned off" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText(/Next step/)).toBeVisible();
    expect(screen.getByText(/Who to ask/)).toBeVisible();
  });
});
