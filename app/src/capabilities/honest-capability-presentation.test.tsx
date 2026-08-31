import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAccountingSummary } from "../accounting/money-api";
import { summaryResponse } from "../accounting/money-fixtures";
import {
  loadQuickBooksConnection,
  loadQuickBooksFinalInvoice,
  newQuickBooksActionKey,
} from "../accounting/quickbooks-api";
import { QuickBooksFinalInvoicePage, QuickBooksSettingsPage } from "../accounting/quickbooks-page";
import { quickBooksFinalInvoiceFixture } from "../accounting/quickbooks-test-fixture";
import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadFacetDesignEvidence } from "../facet/facet-design-api";
import { FacetDesignPage } from "../facet/facet-design-page";
import { loadIntegrationReadiness } from "../integrations/integration-readiness-api";
import { IntegrationReadinessPage } from "../integrations/integration-readiness-page";
import { loadNewoOperations } from "../newo/newo-operations-api";
import { newoOperationsFixture } from "../newo/newo-operations-test-fixture";
import { NewoOperationsPage } from "../newo/newo-operations-page";
import { listDevicePairings, listFieldUsers } from "../pairing/pairing-api";
import { DevicePairingSettings } from "../pairing/device-pairing-settings";
import { loadPostizIntent } from "../postiz/postiz-api";
import { PostizPage } from "../postiz/postiz-page";
import { postizIntentFixture } from "../postiz/postiz-test-fixture";
import { ProposalPublicationAction } from "../proposal/proposal-publication-action";
import { loadProposalPublicationApprovals } from "../proposal/proposal-publication-api";
import { setMobileViewport } from "../test/mobile-viewport";
import { loadCapabilitySignal } from "./capability-api";
import type { Capability } from "./capability-contracts";
import {
  capabilitySignal,
  officeCapability,
  scopedCapability,
  unconfiguredOfficeCapability,
} from "./capability-test-fixture";

/**
 * The proof for ELEC-236: every capability in scope, presented at its real state, on a phone.
 *
 * These assertions — not the screenshots — are what says the PWA is honest. Each one renders a
 * real surface at a 390x844 viewport with the capability signal answering the way the reference
 * deployment actually answers today, and checks three things the old screens could not tell
 * apart: switched off is not absent, switched off is not unconfigured, and neither is ordinary
 * emptiness or a failed read. Where a control would fail, it is also asserted not to be live.
 */

vi.mock("./capability-api", () => ({ loadCapabilitySignal: vi.fn() }));
vi.mock("../accounting/quickbooks-api", () => ({
  loadQuickBooksConnection: vi.fn(),
  loadQuickBooksFinalInvoice: vi.fn(),
  connectQuickBooks: vi.fn(),
  approveQuickBooksFinalInvoice: vi.fn(),
  rejectQuickBooksFinalInvoice: vi.fn(),
  reconcileQuickBooksFinalInvoice: vi.fn(),
  removeQuickBooksFromIronWrap: vi.fn(),
  saveQuickBooksFinalInvoiceMapping: vi.fn(),
  newQuickBooksActionKey: vi.fn(),
}));
vi.mock("../accounting/money-api", () => ({ loadAccountingSummary: vi.fn() }));
vi.mock("../facet/facet-design-api", () => ({ loadFacetDesignEvidence: vi.fn() }));
vi.mock("../integrations/integration-readiness-api", () => ({
  loadIntegrationReadiness: vi.fn(),
}));
vi.mock("../newo/newo-operations-api", () => ({ loadNewoOperations: vi.fn() }));
vi.mock("../pairing/pairing-api", () => ({
  issueDevicePairing: vi.fn(),
  issueHermesDesktopPairing: vi.fn(),
  listDevicePairings: vi.fn(),
  listFieldUsers: vi.fn(),
  revokeDevicePairing: vi.fn(),
}));
vi.mock("../postiz/postiz-api", () => ({
  loadPostizIntent: vi.fn(),
  connectPostiz: vi.fn(),
  approvePostizIntent: vi.fn(),
  rejectPostizIntent: vi.fn(),
  stopPostizIntent: vi.fn(),
  reconcilePostizIntent: vi.fn(),
  newPostizActionKey: vi.fn(() => "postiz:test:key"),
}));
vi.mock("../proposal/proposal-publication-api", () => ({
  approveProposalPublication: vi.fn(),
  loadProposalPublicationApprovals: vi.fn(),
  newProposalPublicationDecisionKey: vi.fn(() => "decision:key"),
  newProposalPublicationPrepareKey: vi.fn(() => "prepare:key"),
  prepareProposalPublication: vi.fn(),
  rejectProposalPublication: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ intentId: "qbo_final_01JEXAMPLE0001" }),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

function sessionFor(role: AuthenticatedSession["user"]["role"]): AuthenticatedSession {
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
    permissions: ["owner:read"],
    allowed_actions: [],
    csrf_token: "csrf",
    session_expires_at: "2036-08-31T00:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-08-31T00:00:00.000Z",
    stale_fields: [],
  };
}

function renderOnAPhone(
  element: ReactElement,
  role: AuthenticatedSession["user"]["role"] = "owner",
) {
  setMobileViewport();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={sessionFor(role)}>{element}</SessionProvider>
    </QueryClientProvider>,
  );
}

function signalOf(role: AuthenticatedSession["user"]["role"], capabilities: Capability[]) {
  vi.mocked(loadCapabilitySignal).mockResolvedValue(capabilitySignal(role, capabilities));
}

/** The ERPNext desk is never an answer for an end user, on any surface this task touches. */
function expectNoFrappeDesk(): void {
  const desk = document.querySelectorAll('a[href*="/app/"], a[href*="/desk"], a[href*="erpnext"]');
  expect(desk.length, "a link into the Frappe administration interface is on screen").toBe(0);
}

beforeEach(() => {
  vi.mocked(loadCapabilitySignal).mockResolvedValue(capabilitySignal("owner", []));
  vi.mocked(newQuickBooksActionKey).mockReturnValue("quickbooks:test:key");
  vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
});

describe("QuickBooks OAuth", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/accounting/quickbooks");
    vi.mocked(loadQuickBooksConnection).mockResolvedValue({
      version: 1,
      state: "connection_required",
      connection_version: 0,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["connect"],
    });
  });

  it("says the connection is switched off, names who can change it, and does not offer a connect button that would fail", async () => {
    signalOf("owner", [
      officeCapability("quickbooks_oauth", "QuickBooks connection", {
        flag_binding: "QB_OAUTH_ENABLED",
      }),
    ]);
    renderOnAPhone(<QuickBooksSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "QuickBooks connection is turned off" }),
    ).toBeVisible();
    expect(screen.getByText("Turned off")).toBeVisible();
    expect(screen.getByText(/Next step/)).toBeVisible();
    expect(screen.getByText(/Who to ask/)).toBeVisible();
    // The dead affordance this replaces: "Connect QuickBooks" used to render whatever the flag
    // said and failed only after the tap.
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
    expect(
      screen.queryByText("No connection change is permitted in this recorded state."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expectNoFrappeDesk();
  });

  it("keeps on-but-unconfigured apart from switched off, and names the setup that is missing", async () => {
    signalOf("owner", [
      unconfiguredOfficeCapability("quickbooks_oauth", "QuickBooks connection", [
        "QBO_CLIENT_ID",
        "QBO_CLIENT_SECRET",
      ]),
    ]);
    renderOnAPhone(<QuickBooksSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "QuickBooks connection is not set up yet" }),
    ).toBeVisible();
    expect(screen.getByText("Setup not finished")).toBeVisible();
    expect(screen.getByText(/QBO_CLIENT_ID, QBO_CLIENT_SECRET/)).toBeVisible();
    expect(screen.queryByText(/is turned off/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
  });

  it("claims nothing at all when the capability signal could not be read", async () => {
    vi.mocked(loadCapabilitySignal).mockRejectedValue(new Error("unreadable"));
    renderOnAPhone(<QuickBooksSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "Connect the intended company" }),
    ).toBeVisible();
    expect(screen.queryByText("Turned off")).toBeNull();
    expect(screen.queryByText("Setup not finished")).toBeNull();
    // A failed read is not evidence that anything is switched off, so the button stays live.
    expect(screen.getByRole("button", { name: "Connect QuickBooks" })).toBeEnabled();
  });
});

describe("QuickBooks final-invoice execution", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/accounting/quickbooks/final-invoices/x");
    vi.mocked(loadQuickBooksFinalInvoice).mockResolvedValue(quickBooksFinalInvoiceFixture());
  });

  it("withholds the financial actions entirely and says the approved intent is waiting, not failing", async () => {
    signalOf("accounting", [
      scopedCapability("quickbooks_final_invoice", "QuickBooks final-invoice execution"),
    ]);
    renderOnAPhone(<QuickBooksFinalInvoicePage />, "accounting");

    expect(
      await screen.findByRole("heading", {
        name: "QuickBooks final-invoice execution is turned off",
      }),
    ).toBeVisible();
    // Approve, reject and reconcile are financial actions on something that cannot execute:
    // offering them disabled would still be the wrong shape.
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconcile exact invoice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
    expectNoFrappeDesk();
  });

  // A control for the assertion above: the same fixture DOES offer those buttons when the
  // capability is reachable, so "they are gone" is evidence about the capability and not about a
  // page that failed to render.
  it("still offers approve and reject when the capability is reachable", async () => {
    signalOf("accounting", [
      scopedCapability("quickbooks_final_invoice", "QuickBooks final-invoice execution", {
        state: "available",
        reason: "flag_on_and_configured",
        flag_state: "on",
        configuration_state: "configured",
      }),
    ]);
    renderOnAPhone(<QuickBooksFinalInvoicePage />, "accounting");

    expect(await screen.findByRole("button", { name: /Approve/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeVisible();
    expect(screen.queryByText("Turned off")).toBeNull();
  });

  it("gives an accounting role the scoped projection with no binding name in it", async () => {
    signalOf("accounting", [
      scopedCapability("quickbooks_final_invoice", "QuickBooks final-invoice execution", {
        state: "unconfigured",
        reason: "configuration_incomplete",
        flag_state: "on",
        configuration_state: "incomplete",
      }),
    ]);
    renderOnAPhone(<QuickBooksFinalInvoicePage />, "accounting");

    expect(
      await screen.findByRole("heading", {
        name: "QuickBooks final-invoice execution is not set up yet",
      }),
    ).toBeVisible();
    // The privacy boundary: a non-office role is told the state, never which binding is blank.
    expect(document.body.textContent).not.toMatch(/QB_[A-Z_]+|QBO_[A-Z_]+/);
  });
});

describe("Hermes desktop", () => {
  beforeEach(() => {
    vi.mocked(listFieldUsers).mockResolvedValue({
      users: [
        {
          id: "appu_crew",
          display_name: "Crew One",
          email: "crew@example.invalid",
          frappe_user_id: null,
        },
      ],
    });
    vi.mocked(listDevicePairings).mockResolvedValue({ devices: [] });
  });

  it("disables the pairing link button and says why, instead of failing after the tap", async () => {
    signalOf("owner", [
      officeCapability("hermes_desktop", "Hermes desktop pilot", {
        flag_binding: "APP_HERMES_DESKTOP_ENABLED",
      }),
    ]);
    renderOnAPhone(<DevicePairingSettings />);

    expect(
      await screen.findByRole("heading", { name: "Hermes desktop pilot is turned off" }),
    ).toBeVisible();
    // Disabled, not hidden and not relabelled: the accessible name still says what is
    // unavailable, and the panel beside it says why.
    expect(screen.getByRole("button", { name: "Issue desktop pairing link" })).toBeDisabled();
    expectNoFrappeDesk();
  });

  it("leaves the button live when the capability is reachable", async () => {
    signalOf("owner", [
      officeCapability("hermes_desktop", "Hermes desktop pilot", {
        state: "available",
        reason: "flag_on_and_configured",
        flag_state: "on",
        configuration_state: "configured",
      }),
    ]);
    renderOnAPhone(<DevicePairingSettings />);

    expect(await screen.findByRole("button", { name: "Issue desktop pairing link" })).toBeEnabled();
    // Reachable is never rendered as proven, verified or connected.
    expect(screen.queryByText(/proven|verified/i)).toBeNull();
  });
});

describe("Newo", () => {
  it("leads with the state instead of burying it as one row in a fact table", async () => {
    vi.mocked(loadNewoOperations).mockResolvedValue(newoOperationsFixture());
    signalOf("owner", [
      officeCapability("newo", "Newo voice reception", { flag_binding: "NEWO_ENABLED" }),
    ]);
    renderOnAPhone(<NewoOperationsPage />);

    expect(
      await screen.findByRole("heading", { name: "Newo voice reception is turned off" }),
    ).toBeVisible();
    expect(screen.getByText("Turned off")).toBeVisible();
    expectNoFrappeDesk();
  });

  it("falls back to the Worker's own flag when the capability signal could not be read, and says it cannot tell off from unconfigured", async () => {
    vi.mocked(loadNewoOperations).mockResolvedValue(newoOperationsFixture());
    vi.mocked(loadCapabilitySignal).mockRejectedValue(new Error("unreadable"));
    renderOnAPhone(<NewoOperationsPage />);

    expect(await screen.findByText("Reception is turned off for this company")).toBeVisible();
    expect(screen.getByText(/could not read the capability signal/)).toBeVisible();
  });
});

describe("Postiz", () => {
  it("replaces the bare notice with an actor, a next step and a person to ask", async () => {
    vi.mocked(loadPostizIntent).mockResolvedValue({
      ...postizIntentFixture(),
      enabled: false,
    });
    signalOf("owner", [
      officeCapability("postiz", "Postiz marketing publication", {
        flag_binding: "POSTIZ_ENABLED",
      }),
    ]);
    renderOnAPhone(<PostizPage />);

    expect(
      await screen.findByRole("heading", { name: "Postiz marketing publication is turned off" }),
    ).toBeVisible();
    expect(screen.getByText(/Who to ask/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Connect Facebook/ })).toBeNull();
    expectNoFrappeDesk();
  });

  // The same control: with the capability reachable the review action is live again, so the
  // absence above is the capability speaking, not a page that never mounted.
  it("leaves the review action live when the capability is reachable", async () => {
    vi.mocked(loadPostizIntent).mockResolvedValue(postizIntentFixture());
    signalOf("owner", [
      officeCapability("postiz", "Postiz marketing publication", {
        state: "available",
        reason: "flag_on_and_configured",
        flag_state: "on",
        configuration_state: "configured",
      }),
    ]);
    renderOnAPhone(<PostizPage />);

    expect(await screen.findByRole("button", { name: /Approve/ })).toBeVisible();
    expect(screen.queryByText("Turned off")).toBeNull();
  });
});

describe("Facet design delivery", () => {
  it("does not let an unfinished setup look like an empty list", async () => {
    vi.mocked(loadFacetDesignEvidence).mockResolvedValue({
      version: 2,
      read_model_generated_at: "2026-08-31T00:00:00.000Z",
      permissions: ["facet:read"],
      allowed_actions: ["facet_design.read"],
      evidence: [],
      intake_exceptions: [],
    });
    signalOf("owner", [
      unconfiguredOfficeCapability("facet_design_ingest", "Facet design delivery", [
        "FACET_V2_ROUTES_JSON",
        "FACET_V2_KEYS_JSON",
      ]),
    ]);
    renderOnAPhone(<FacetDesignPage />);

    expect(
      await screen.findByRole("heading", { name: "Facet design delivery is not set up yet" }),
    ).toBeVisible();
    // "No signed Facet decisions yet" is a no-current-data state and must not stand in for a
    // no-configuration one (annex §6.1).
    expect(screen.queryByText("No signed Facet decisions yet")).toBeNull();
  });

  it("still shows ordinary emptiness when the capability is reachable and nothing has arrived", async () => {
    vi.mocked(loadFacetDesignEvidence).mockResolvedValue({
      version: 2,
      read_model_generated_at: "2026-08-31T00:00:00.000Z",
      permissions: ["facet:read"],
      allowed_actions: ["facet_design.read"],
      evidence: [],
      intake_exceptions: [],
    });
    signalOf("owner", [
      officeCapability("facet_design_ingest", "Facet design delivery", {
        state: "available",
        reason: "flag_on_and_configured",
        flag_state: "on",
        configuration_state: "configured",
      }),
    ]);
    renderOnAPhone(<FacetDesignPage />);

    expect(await screen.findByText("No signed Facet decisions yet")).toBeVisible();
    expect(screen.queryByText("Setup not finished")).toBeNull();
  });
});

describe("Proposal publication and the proposal document template", () => {
  const approvalsResponse = {
    version: 1 as const,
    read_model_generated_at: "2026-08-31T00:00:00.000Z",
    permissions: ["jobs:read:any"],
    allowed_actions: ["proposal_publication_approval.read"] as never,
    approvals: [],
  };

  function renderAction(role: AuthenticatedSession["user"]["role"] = "owner") {
    return renderOnAPhone(
      <ProposalPublicationAction
        roofJobId="JOB-A"
        proposalEvidencePackId="proposal:customer-quote:JOB-A-v1"
        proposalStatus="Draft"
        locale="en-CA"
      />,
      role,
    );
  }

  beforeEach(() => {
    vi.mocked(loadProposalPublicationApprovals).mockResolvedValue(approvalsResponse);
  });

  it("names publication as the blocking step when publication is off and the template is unfinished", async () => {
    signalOf("owner", [
      officeCapability("proposal_publication", "Proposal publication to the customer", {
        flag_binding: "APP_PROPOSAL_PUBLICATION_ENABLED",
      }),
      unconfiguredOfficeCapability("proposal_template", "Proposal document template", [
        "PROPOSAL_TEMPLATE_DOC_ID",
      ]),
    ]);
    renderAction();

    expect(
      await screen.findByRole("heading", {
        name: "Proposal publication to the customer is turned off",
      }),
    ).toBeVisible();
    // Two flags, two different fixes. Leading with the template would send an owner to finish a
    // setup that cannot matter until publication is on.
    expect(screen.queryByText(/Proposal document template is not set up yet/)).toBeNull();
    expect(screen.queryByText("Publication is not available on this runtime.")).toBeNull();
  });

  it("names the template when publication is on and only the document is missing", async () => {
    signalOf("owner", [
      officeCapability("proposal_publication", "Proposal publication to the customer", {
        state: "available",
        reason: "flag_on_and_configured",
        flag_state: "on",
        configuration_state: "configured",
      }),
      unconfiguredOfficeCapability("proposal_template", "Proposal document template", [
        "PROPOSAL_TEMPLATE_DOC_ID",
      ]),
    ]);
    renderAction();

    expect(
      await screen.findByRole("heading", { name: "Proposal document template is not set up yet" }),
    ).toBeVisible();
    expect(screen.getByText(/PROPOSAL_TEMPLATE_DOC_ID/)).toBeVisible();
  });

  it("tells a non-office role that publishing is not theirs, instead of rendering nothing at all", async () => {
    signalOf("sales", []);
    renderAction("sales");

    expect(
      await screen.findByRole("heading", { name: "Publishing to the customer is not your role" }),
    ).toBeVisible();
    expect(screen.getByText("Not your role")).toBeVisible();
    expect(screen.getByText(/Ask your owner or operations lead/)).toBeVisible();
  });
});

describe("Integration readiness", () => {
  const readiness = {
    version: 1 as const,
    tenant_id: "ironwrap",
    read_model_generated_at: "2026-08-31T00:00:00.000Z",
    allowed_actions: ["integrations.readiness.read"] as ["integrations.readiness.read"],
    configuration_mutations_available: false as const,
    profile: {
      key: "reference_journey" as const,
      version: 3,
      state: "blocked" as const,
      blockers: [],
      dependencies: [],
    },
    capabilities: [
      {
        id: "newo" as const,
        required: true,
        state: "blocked" as const,
        last_proof_at: null,
        proof_expires_at: null,
        fallback: "Answer the phone.",
        blockers: ["manifest_disabled"],
        manifest: null,
      },
      {
        id: "email_delivery" as const,
        required: true,
        state: "ready" as const,
        last_proof_at: null,
        proof_expires_at: null,
        fallback: null,
        blockers: [],
        manifest: null,
      },
    ],
    verdict: "blocked" as const,
  };

  beforeEach(() => {
    vi.mocked(loadIntegrationReadiness).mockResolvedValue(readiness);
  });

  it("shows a deliberately switched-off rail as safely disabled and drops it out of the ready count", async () => {
    signalOf("owner", []);
    renderOnAPhone(<IntegrationReadinessPage />);

    expect(await screen.findByLabelText("Newo safely disabled")).toBeVisible();
    expect(screen.getByText("1 of 1 ready")).toBeVisible();
    expect(screen.getByText("1 deliberately switched off, and not counted above.")).toBeVisible();
    expectNoFrappeDesk();
  });

  it("keeps reachability and proof as two labelled answers, and never renders an absent capability", async () => {
    signalOf("owner", [
      officeCapability("postiz", "Postiz marketing publication"),
      officeCapability("facet_quote_revision_prepare", "Facet quote-revision preparation", {
        presence: "absent",
        state: "absent",
        reason: "no_source_consumer",
      }),
    ]);
    renderOnAPhone(<IntegrationReadinessPage />);

    expect(await screen.findByText("Capability availability")).toBeVisible();
    expect(screen.getByText(/A different question from the proof above/)).toBeVisible();
    expect(screen.getByText(/Reachable — not proven/)).toBeVisible();
    // An absent capability names nothing a user gets, so it is rendered nowhere, in any styling.
    expect(screen.queryByText("Facet quote-revision preparation")).toBeNull();
  });

  it("says the capability state could not be read rather than reporting anything as off", async () => {
    vi.mocked(loadCapabilitySignal).mockRejectedValue(new Error("unreadable"));
    renderOnAPhone(<IntegrationReadinessPage />);

    expect(await screen.findByText(/Nothing here is being reported as switched off/)).toBeVisible();
  });
});
