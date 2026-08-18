import {
  BriefcaseBusiness,
  CalendarClock,
  CircleGauge,
  ClipboardCheck,
  Headphones,
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
    | "/newo"
    | "/accounting/quickbooks"
    | "/settings";
  icon: LucideIcon;
  activeColor: "accent" | "ok" | "warning";
}

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
  accounting: [
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
