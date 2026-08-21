import { describe, expect, it } from "vitest";

import authBoundary from "./auth/auth-boundary.tsx?raw";
import moneyDesk from "./accounting/money-desk-page.tsx?raw";
import appShell from "./components/app-shell.tsx?raw";
import todayPage from "./field/today-page.tsx?raw";
import fieldPages from "./field/field-pages.tsx?raw";
import workPackageIssue from "./field/work-package-issue-form.tsx?raw";
import inventoryPage from "./inventory/inventory-page.tsx?raw";
import nowPage from "./now/now-page.tsx?raw";
import operatingIntake from "./operating-intake/operating-intake-panel.tsx?raw";
import ownerNow from "./owner/owner-now-page.tsx?raw";
import portalPage from "./portal/customer-portal-page.tsx?raw";
import productionRunway from "./production/production-runway-page.tsx?raw";
import salesDesk from "./sales/sales-desk-page.tsx?raw";

const deskSources: Record<string, string> = {
  "now/now-page.tsx": nowPage,
  "owner/owner-now-page.tsx": ownerNow,
  "field/today-page.tsx": todayPage,
  "field/field-pages.tsx": fieldPages,
  "field/work-package-issue-form.tsx": workPackageIssue,
  "inventory/inventory-page.tsx": inventoryPage,
  "operating-intake/operating-intake-panel.tsx": operatingIntake,
  "sales/sales-desk-page.tsx": salesDesk,
  "production/production-runway-page.tsx": productionRunway,
  "accounting/money-desk-page.tsx": moneyDesk,
  "portal/customer-portal-page.tsx": portalPage,
  "components/app-shell.tsx": appShell,
  "auth/auth-boundary.tsx": authBoundary,
};

describe("IronWrap desk family", () => {
  it("drops side-tab cards and uppercase kickers on planned desk surfaces", () => {
    const sideTab = new RegExp("border-l-" + "[3-9]");
    const kicker = new RegExp("uppercase tracking-\\[0\\.1[46]em\\]");
    const insetTab = new RegExp("inset_3px_0_0_var\\(--accent\\)");
    for (const [file, source] of Object.entries(deskSources)) {
      expect(source, file).not.toMatch(sideTab);
      expect(source, file).not.toMatch(kicker);
      expect(source, file).not.toMatch(insetTab);
    }
  });

  it("keeps Safety reachable from the authenticated shell", () => {
    expect(appShell).toMatch(/SafetyActionPanel/);
    expect(appShell).toMatch(/>Safety</);
    expect(appShell).toMatch(/bg-surface(?!\/)/);
  });

  it("puts magic-link consume on a dusk stage", () => {
    expect(authBoundary).toMatch(/bg-chrome/);
  });
});
