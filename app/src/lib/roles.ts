import {
  Banknote,
  BriefcaseBusiness,
  CalendarClock,
  CircleGauge,
  ClipboardCheck,
  Headphones,
  LifeBuoy,
  Palette,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export const appRoles = ["owner", "ops", "sales", "production", "accounting", "field"] as const;
export type AppRole = (typeof appRoles)[number];
export type RoleSurface =
  "owner" | "sales" | "production" | "accounting" | "newo" | "job" | "field";

export interface NavigationItem {
  label: string;
  mobileLabel?: string;
  to:
    | "/now"
    | "/today"
    | "/check-in"
    | "/owner"
    | "/facet-designs"
    | "/approvals"
    | "/production"
    | "/sales"
    | "/service"
    | "/newo"
    | "/accounting"
    | "/accounting/exceptions"
    | "/accounting/quickbooks"
    | "/settings";
  icon: LucideIcon;
  activeColor: "accent" | "ok" | "warning";
}

// Deliberately unchanged by IRO-52 slice S9. The mobile bar already carries nine items, which on a
// 360 px viewport is about 38 px each - under the touch-target floor before anything is added. The
// money desk is the accounting role's surface and lives in that role's navigation below; owner and
// ops reach it the same way they already reach `/accounting/quickbooks`, by link. Widening this bar
// to ten would degrade the mobile experience for every office role, which the product rule forbids.
const officeNavigation = [
  { label: "Now", to: "/now", icon: CircleGauge, activeColor: "warning" },
  {
    label: "Reception",
    mobileLabel: "Calls",
    to: "/newo",
    icon: Headphones,
    activeColor: "warning",
  },
  {
    label: "Production",
    mobileLabel: "Jobs",
    to: "/production",
    icon: CalendarClock,
    activeColor: "ok",
  },
  {
    label: "Approvals",
    mobileLabel: "Approve",
    to: "/approvals",
    icon: ShieldCheck,
    activeColor: "warning",
  },
  {
    label: "Service",
    mobileLabel: "Callbacks",
    to: "/service",
    icon: LifeBuoy,
    activeColor: "warning",
  },
  { label: "Today", to: "/today", icon: ClipboardCheck, activeColor: "accent" },
  { label: "Sales", to: "/sales", icon: BriefcaseBusiness, activeColor: "ok" },
  {
    label: "Facet designs",
    mobileLabel: "Designs",
    to: "/facet-designs",
    icon: Palette,
    activeColor: "accent",
  },
  {
    label: "Settings",
    mobileLabel: "Setup",
    to: "/settings",
    icon: Settings,
    activeColor: "accent",
  },
] as const satisfies readonly NavigationItem[];

const navigationByRole: Record<AppRole, readonly NavigationItem[]> = {
  owner: officeNavigation,
  ops: officeNavigation,
  sales: [
    { label: "Now", to: "/now", icon: CircleGauge, activeColor: "warning" },
    { label: "Sales", to: "/sales", icon: BriefcaseBusiness, activeColor: "ok" },
    {
      label: "Settings",
      mobileLabel: "Setup",
      to: "/settings",
      icon: Settings,
      activeColor: "accent",
    },
  ],
  production: [
    { label: "Now", to: "/now", icon: CircleGauge, activeColor: "warning" },
    {
      label: "Production",
      mobileLabel: "Jobs",
      to: "/production",
      icon: CalendarClock,
      activeColor: "ok",
    },
    {
      label: "Settings",
      mobileLabel: "Setup",
      to: "/settings",
      icon: Settings,
      activeColor: "accent",
    },
  ],
  // The money desk leads, because it is the accounting role's landing page (contract section 8.2)
  // and the work; QuickBooks is a connection setting, not a queue.
  accounting: [
    {
      label: "Money desk",
      mobileLabel: "Money",
      to: "/accounting",
      icon: Banknote,
      activeColor: "ok",
    },
    {
      label: "Exceptions",
      mobileLabel: "Issues",
      to: "/accounting/exceptions",
      icon: ShieldCheck,
      activeColor: "warning",
    },
    { label: "Now", to: "/now", icon: CircleGauge, activeColor: "warning" },
    {
      label: "Settings",
      mobileLabel: "Setup",
      to: "/accounting/quickbooks",
      icon: Settings,
      activeColor: "accent",
    },
  ],
  field: [
    { label: "Now", to: "/now", icon: CircleGauge, activeColor: "accent" },
    { label: "Check-in", to: "/check-in", icon: BriefcaseBusiness, activeColor: "ok" },
    { label: "Settings", to: "/settings", icon: Settings, activeColor: "accent" },
  ],
};

export function navigationForRole(role: AppRole): readonly NavigationItem[] {
  return navigationByRole[role];
}

export function roleCanAccess(role: AppRole, surface: RoleSurface): boolean {
  if (surface === "accounting") return role === "owner" || role === "accounting";
  if (role === "accounting") return false;
  if (surface === "job")
    return role === "owner" || role === "ops" || role === "production" || role === "field";
  if (role === "sales") return surface === "sales";
  if (role === "production") return surface === "production";
  if (surface === "field") return role === "field" || role === "ops" || role === "owner";
  return role === "owner" || role === "ops";
}

export function roleLabel(role: AppRole): string {
  return role === "owner"
    ? "Owner"
    : role === "ops"
      ? "Operations"
      : role === "sales"
        ? "Sales"
        : role === "production"
          ? "Production"
          : role === "accounting"
            ? "Accounting"
            : "Field crew";
}
