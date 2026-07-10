import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { useState } from "react";

import { AuthBoundary } from "./auth/auth-boundary";
import { MagicLinkConsume } from "./auth/magic-link-consume";
import { takeMagicLinkTokenFromWindow } from "./auth/magic-link-fragment";
import { AppShell } from "./components/app-shell";
import {
  CheckInPage,
  JobPage,
  NotFoundPage,
  OwnerNowPage,
  PortalLinkRequiredPage,
  PortalPage,
  SalesPage,
  SettingsPage,
  TodayPage,
} from "./pages/placeholders";

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/today" });
  },
});

const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/verify",
  component: VerifyRoute,
});

function VerifyRoute() {
  const [token] = useState(() => takeMagicLinkTokenFromWindow());
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <MagicLinkConsume token={token} />
    </main>
  );
}

const portalRootRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/portal",
  component: PortalLinkRequiredPage,
});

const portalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/portal/$token",
  component: PortalPage,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authenticated",
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  return (
    <AuthBoundary>
      <AppShell />
    </AuthBoundary>
  );
}

const todayRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/today",
  component: TodayPage,
});

const jobRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/jobs/$jobId",
  component: JobPage,
});

const checkInRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/check-in",
  component: CheckInPage,
});

const jobCheckInRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/check-in/$jobId",
  component: CheckInPage,
});

const ownerRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/owner",
  component: OwnerNowPage,
});

const salesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/sales",
  component: SalesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  verifyRoute,
  portalRootRoute,
  portalRoute,
  authenticatedRoute.addChildren([
    todayRoute,
    jobRoute,
    checkInRoute,
    jobCheckInRoute,
    ownerRoute,
    salesRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
