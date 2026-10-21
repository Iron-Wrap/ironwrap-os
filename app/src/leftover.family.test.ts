import { describe, expect, it } from "vitest";

import moneyExceptions from "./accounting/money-exceptions-page.tsx?raw";
import moneyIntent from "./accounting/money-intent-page.tsx?raw";
import quickbooks from "./accounting/quickbooks-page.tsx?raw";
import appShell from "./components/app-shell.tsx?raw";
import estimator from "./estimator/estimator-workbench-page.tsx?raw";
import quoteRevision from "./estimator/quote-revision-approval-page.tsx?raw";
import facetInbox from "./facet/facet-design-page.tsx?raw";
import fieldPages from "./field/field-pages.tsx?raw";
import fleetPage from "./field/fleet-page.tsx?raw";
import safetyPanel from "./field/safety-action-panel.tsx?raw";
import newo from "./newo/newo-operations-page.tsx?raw";
import approvals from "./owner/approval-inbox-page.tsx?raw";
import placeholders from "./pages/placeholders.tsx?raw";
import pairing from "./pairing/device-pairing-settings.tsx?raw";
import contractAccept from "./portal/customer-contract-acceptance-page.tsx?raw";
import postiz from "./postiz/postiz-page.tsx?raw";
import publicEstimate from "./public-estimate/public-estimate-page.tsx?raw";
import leadTriage from "./sales/lead-triage-prepare-page.tsx?raw";
import serviceCase from "./service/service-case-page.tsx?raw";
import serviceDesk from "./service/service-desk-page.tsx?raw";

const leftoverSources: Record<string, string> = {
  "field/field-pages.tsx": fieldPages,
  "field/fleet-page.tsx": fleetPage,
  "field/safety-action-panel.tsx": safetyPanel,
  "owner/approval-inbox-page.tsx": approvals,
  "sales/lead-triage-prepare-page.tsx": leadTriage,
  "estimator/estimator-workbench-page.tsx": estimator,
  "estimator/quote-revision-approval-page.tsx": quoteRevision,
  "service/service-desk-page.tsx": serviceDesk,
  "service/service-case-page.tsx": serviceCase,
  "newo/newo-operations-page.tsx": newo,
  "postiz/postiz-page.tsx": postiz,
  "accounting/money-intent-page.tsx": moneyIntent,
  "accounting/money-exceptions-page.tsx": moneyExceptions,
  "accounting/quickbooks-page.tsx": quickbooks,
  "facet/facet-design-page.tsx": facetInbox,
  "pairing/device-pairing-settings.tsx": pairing,
  "pages/placeholders.tsx": placeholders,
  "portal/customer-contract-acceptance-page.tsx": contractAccept,
  "public-estimate/public-estimate-page.tsx": publicEstimate,
};

describe("IronWrap leftover family", () => {
  it("drops leftover uppercase kickers and side-tabs on leftover IDs", () => {
    const sideTab = new RegExp("border-l-" + "[3-9]");
    const kicker = new RegExp("uppercase tracking-\\[0\\.1[46]em\\]");
    const insetTab = new RegExp("inset_3px_0_0_var\\(--accent\\)");
    for (const [file, source] of Object.entries(leftoverSources)) {
      expect(source, file).not.toMatch(sideTab);
      expect(source, file).not.toMatch(kicker);
      expect(source, file).not.toMatch(insetTab);
    }
  });

  it("keeps the job packet a packet, not a dashboard costume", () => {
    expect(fieldPages).toMatch(/function JobPage/);
    expect(fieldPages).toMatch(/Work checks/);
    expect(fieldPages).toMatch(/Job details/);
    expect(fieldPages).not.toMatch(/uppercase tracking-\[0\.16em\]/);
    expect(fieldPages).toMatch(/Add job proof/);
  });

  it("keeps Safety geometry and reachability", () => {
    expect(appShell).toMatch(/SafetyActionPanel/);
    expect(safetyPanel).toMatch(/id="safety-actions"/);
    expect(safetyPanel).toMatch(/Call for rescue/);
    expect(safetyPanel).toMatch(/Report a hazard or injury/);
    expect(safetyPanel).toMatch(/Record making it safe/);
    expect(safetyPanel).toMatch(/Mark equipment unsafe/);
    expect(safetyPanel).toMatch(/size="field"/);
  });

  it("makes the approvals inbox ruled rows and oxide only on commit", () => {
    expect(approvals).toMatch(/Lead reviews/);
    expect(approvals).toMatch(/divide-y/);
    expect(approvals).not.toMatch(/uppercase tracking-\[0\.16em\]/);
    expect(approvals).toMatch(/variant="accent"/);
  });

  it("keeps customer contract and public estimate off the office rail", () => {
    expect(contractAccept).toMatch(/Accept your contract/);
    expect(contractAccept).not.toMatch(/AppShell/);
    expect(publicEstimate).not.toMatch(/AppShell/);
    expect(placeholders).toMatch(/window\.location\.assign\("\/now"\)/);
    expect(placeholders).toMatch(/bg-chrome/);
  });

  it("keeps pairing on the dusk mineral family", () => {
    expect(pairing).toMatch(/Crew phones/);
    expect(pairing).not.toMatch(/Office controls/);
    expect(fleetPage).toMatch(/Vehicle/);
  });
});
