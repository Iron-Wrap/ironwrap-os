import {
  BriefcaseBusiness,
  CalendarClock,
  CircleGauge,
  ClipboardCheck,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export const appRoles = ["owner", "ops", "field"] as const;
export type AppRole = (typeof appRoles)[number];

export interface NavigationItem {
  label: string;
  to: "/today" | "/check-in" | "/owner" | "/approvals" | "/production" | "/sales" | "/settings";
  icon: LucideIcon;
  activeColor: "accent" | "ok" | "warning";
}

const navigationByRole: Record<AppRole, readonly NavigationItem[]> = {
  owner: [
    { label: "Now", to: "/owner", icon: CircleGauge, activeColor: "warning" },
    { label: "Production", to: "/production", icon: CalendarClock, activeColor: "ok" },
    { label: "Approvals", to: "/approvals", icon: ShieldCheck, activeColor: "warning" },
    { label: "Today", to: "/today", icon: ClipboardCheck, activeColor: "accent" },
    { label: "Sales", to: "/sales", icon: BriefcaseBusiness, activeColor: "ok" },
    { label: "Settings", to: "/settings", icon: Settings, activeColor: "accent" },
  ],
  ops: [
    { label: "Now", to: "/owner", icon: CircleGauge, activeColor: "warning" },
    { label: "Production", to: "/production", icon: CalendarClock, activeColor: "ok" },
    { label: "Approvals", to: "/approvals", icon: ShieldCheck, activeColor: "warning" },
    { label: "Today", to: "/today", icon: ClipboardCheck, activeColor: "accent" },
    { label: "Sales", to: "/sales", icon: BriefcaseBusiness, activeColor: "ok" },
    { label: "Settings", to: "/settings", icon: Settings, activeColor: "accent" },
  ],
  field: [
    { label: "Today", to: "/today", icon: ClipboardCheck, activeColor: "accent" },
    { label: "Check-in", to: "/check-in", icon: BriefcaseBusiness, activeColor: "ok" },
    { label: "Settings", to: "/settings", icon: Settings, activeColor: "accent" },
  ],
};

export function navigationForRole(role: AppRole): readonly NavigationItem[] {
  return navigationByRole[role];
}

export function roleCanAccess(role: AppRole, surface: "owner" | "sales" | "field"): boolean {
  if (surface === "field") return role === "field" || role === "ops" || role === "owner";
  return role === "owner" || role === "ops";
}

export function roleLabel(role: AppRole): string {
  return role === "owner" ? "Owner" : role === "ops" ? "Operations" : "Field crew";
}
