import {
  Banknote,
  Boxes,
  BriefcaseBusiness,
  CalendarClock,
  CircleGauge,
  ClipboardCheck,
  Headphones,
  LifeBuoy,
  Palette,
  Settings,
  ShieldCheck,
  Truck,
  type LucideIcon,
} from "lucide-react";

export const appRoles = ["owner", "ops", "sales", "production", "accounting", "field"] as const;
export type AppRole = (typeof appRoles)[number];
export type NavigationWorkspace =
  "Command" | "Revenue" | "Delivery" | "Resources" | "Finance" | "Control";
export type RoleSurface =
  | "owner"
  | "sales"
  | "production"
  | "accounting"
  | "newo"
  | "job"
  | "field"
  | "fleet"
  | "inventory";

export interface NavigationItem {
  label: string;
  mobileLabel?: string;
  mobilePrimary?: boolean;
  workspace: NavigationWorkspace;
  to:
    | "/now"
    | "/today"
    | "/check-in"
    | "/vehicle"
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
    | "/inventory"
    | "/settings";
  icon: LucideIcon;
  activeColor: "accent" | "ok" | "warning";
}

const officeNavigation = [
  {
    label: "Now",
    to: "/now",
    icon: CircleGauge,
    activeColor: "warning",
    workspace: "Command",
    mobilePrimary: true,
  },
  {
    label: "Reception",
    mobileLabel: "Calls",
    to: "/newo",
    icon: Headphones,
    activeColor: "warning",
    workspace: "Revenue",
  },
  {
    label: "Sales",
    mobileLabel: "Leads",
    to: "/sales",
    icon: BriefcaseBusiness,
    activeColor: "ok",
    workspace: "Revenue",
    mobilePrimary: true,
  },
  {
    label: "Designs",
    mobileLabel: "Designs",
    to: "/facet-designs",
    icon: Palette,
    activeColor: "accent",
    workspace: "Revenue",
  },
  {
    label: "Production",
    mobileLabel: "Jobs",
    to: "/production",
    icon: CalendarClock,
    activeColor: "ok",
    workspace: "Delivery",
    mobilePrimary: true,
  },
  {
    label: "Service",
    mobileLabel: "Service",
    to: "/service",
    icon: LifeBuoy,
    activeColor: "warning",
    workspace: "Delivery",
  },
  {
    label: "Today",
    to: "/today",
    icon: ClipboardCheck,
    activeColor: "accent",
    workspace: "Delivery",
  },
  {
    label: "Inventory",
    to: "/inventory",
    icon: Boxes,
    activeColor: "ok",
    workspace: "Resources",
  },
  {
    label: "Approvals",
    mobileLabel: "Approve",
    to: "/approvals",
    icon: ShieldCheck,
    activeColor: "warning",
    workspace: "Control",
  },
  {
    label: "Settings",
    mobileLabel: "Setup",
    to: "/settings",
    icon: Settings,
    activeColor: "accent",
    workspace: "Control",
  },
] as const satisfies readonly NavigationItem[];

const navigationByRole: Record<AppRole, readonly NavigationItem[]> = {
  owner: officeNavigation,
  ops: officeNavigation,
  sales: [
    {
      label: "Now",
      to: "/now",
      icon: CircleGauge,
      activeColor: "warning",
      workspace: "Command",
    },
    {
      label: "Sales",
      to: "/sales",
      icon: BriefcaseBusiness,
      activeColor: "ok",
      workspace: "Revenue",
    },
    {
      label: "Settings",
      mobileLabel: "Setup",
      to: "/settings",
      icon: Settings,
      activeColor: "accent",
      workspace: "Control",
    },
  ],
  production: [
    {
      label: "Now",
      to: "/now",
      icon: CircleGauge,
      activeColor: "warning",
      workspace: "Command",
    },
    {
      label: "Production",
      mobileLabel: "Jobs",
      to: "/production",
      icon: CalendarClock,
      activeColor: "ok",
      workspace: "Delivery",
    },
    {
      label: "Settings",
      mobileLabel: "Setup",
      to: "/settings",
      icon: Settings,
      activeColor: "accent",
      workspace: "Control",
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
      workspace: "Finance",
    },
    {
      label: "Exceptions",
      mobileLabel: "Issues",
      to: "/accounting/exceptions",
      icon: ShieldCheck,
      activeColor: "warning",
      workspace: "Finance",
    },
    {
      label: "Now",
      to: "/now",
      icon: CircleGauge,
      activeColor: "warning",
      workspace: "Command",
    },
    {
      label: "Settings",
      mobileLabel: "Setup",
      to: "/accounting/quickbooks",
      icon: Settings,
      activeColor: "accent",
      workspace: "Control",
    },
  ],
  field: [
    {
      label: "Now",
      to: "/now",
      icon: CircleGauge,
      activeColor: "accent",
      workspace: "Command",
      mobilePrimary: true,
    },
    {
      label: "Check-in",
      to: "/check-in",
      icon: BriefcaseBusiness,
      activeColor: "ok",
      workspace: "Delivery",
      mobilePrimary: true,
    },
    {
      label: "Vehicle",
      to: "/vehicle",
      icon: Truck,
      activeColor: "ok",
      workspace: "Resources",
      mobilePrimary: true,
    },
    {
      label: "Inventory",
      to: "/inventory",
      icon: Boxes,
      activeColor: "ok",
      workspace: "Resources",
    },
    {
      label: "Settings",
      to: "/settings",
      icon: Settings,
      activeColor: "accent",
      workspace: "Control",
    },
  ],
};

export function navigationForRole(role: AppRole): readonly NavigationItem[] {
  return navigationByRole[role];
}

export function roleCanAccess(role: AppRole, surface: RoleSurface): boolean {
  if (surface === "accounting") return role === "owner" || role === "accounting";
  if (role === "accounting") return false;
  // Capturing against a fleet asset is a field-only right: `/api/v1/fleet/*`
  // refuses every other role, so an office user reaching this screen would only
  // meet a 403. The Desk is where the office reads the fleet.
  if (surface === "fleet") return role === "field";
  if (surface === "job")
    return role === "owner" || role === "ops" || role === "production" || role === "field";
  if (role === "sales") return surface === "sales";
  if (role === "production") return surface === "production";
  if (surface === "field") return role === "field" || role === "ops" || role === "owner";
  if (surface === "inventory") return role === "owner" || role === "ops" || role === "field";
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
            : "Crew";
}
