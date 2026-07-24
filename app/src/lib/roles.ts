import {
  BriefcaseBusiness,
  CalendarClock,
  CircleGauge,
  ClipboardCheck,
  Headphones,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export const appRoles = ["owner", "ops", "field"] as const;
export type AppRole = (typeof appRoles)[number];

export interface NavigationItem {
  label: string;
  mobileLabel?: string;
  to:
    | "/today"
    | "/check-in"
    | "/owner"
    | "/approvals"
    | "/production"
    | "/sales"
    | "/newo"
    | "/settings";
  icon: LucideIcon;
  activeColor: "accent" | "ok" | "warning";
}

const officeNavigation = [
  { label: "Now", to: "/owner", icon: CircleGauge, activeColor: "warning" },
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
  field: [
    { label: "Today", to: "/today", icon: ClipboardCheck, activeColor: "accent" },
    { label: "Check-in", to: "/check-in", icon: BriefcaseBusiness, activeColor: "ok" },
    { label: "Settings", to: "/settings", icon: Settings, activeColor: "accent" },
  ],
};

export function navigationForRole(role: AppRole): readonly NavigationItem[] {
  return navigationByRole[role];
}

export function roleCanAccess(
  role: AppRole,
  surface: "owner" | "sales" | "newo" | "field",
): boolean {
  if (surface === "field") return role === "field" || role === "ops" || role === "owner";
  return role === "owner" || role === "ops";
}

export function roleLabel(role: AppRole): string {
  return role === "owner" ? "Owner" : role === "ops" ? "Operations" : "Field crew";
}
