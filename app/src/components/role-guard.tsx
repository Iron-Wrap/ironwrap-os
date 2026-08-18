import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { roleCanAccess, type RoleSurface } from "../lib/roles";
import { Button } from "./ui/button";
import { ErrorState } from "./ui/state-panel";

export function RoleGuard({ surface, children }: { surface: RoleSurface; children: ReactNode }) {
  const { user } = useSession();
  if (roleCanAccess(user.role, surface)) return children;
  return (
    <ErrorState
      title="This work belongs to another role"
      message="Your device is still signed in correctly. Ask the office if your assigned role needs to change."
      action={<ReturnToNow />}
    />
  );
}

export function ReturnToNow() {
  return (
    <Button asChild variant="outline">
      <Link to="/now">Return to Now</Link>
    </Button>
  );
}
