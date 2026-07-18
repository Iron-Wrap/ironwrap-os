import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { roleCanAccess } from "../lib/roles";
import { Button } from "./ui/button";
import { ErrorState } from "./ui/state-panel";

export function RoleGuard({
  surface,
  children,
}: {
  surface: "owner" | "sales" | "newo" | "field";
  children: ReactNode;
}) {
  const { user } = useSession();
  if (roleCanAccess(user.role, surface)) return children;
  return (
    <ErrorState
      title="This work belongs to another role"
      message="Your device is still signed in correctly. Ask the office if your assigned role needs to change."
      action={<ReturnToToday />}
    />
  );
}

export function ReturnToToday() {
  return (
    <Button asChild variant="outline">
      <Link to="/today">Return to Today</Link>
    </Button>
  );
}
