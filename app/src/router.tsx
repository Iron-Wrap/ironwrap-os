import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { AuthBoundary } from "./auth/auth-boundary";
import { DevicePairingConsume } from "./auth/device-pairing-consume";
import { MagicLinkConsume } from "./auth/magic-link-consume";
import { takeMagicLinkTokenFromWindow } from "./auth/magic-link-fragment";
import { takePairingTokenFromWindow } from "./auth/pairing-fragment";
import { AppShell } from "./components/app-shell";
import {
  NotFoundPage,
  PortalLinkRequiredPage,
  PortalPage,
  SettingsPage,
} from "./pages/placeholders";

const OwnerNowPage = lazy(async () => ({
  default: (await import("./owner/owner-now-page")).OwnerNowPage,
}));
const ApprovalInboxPage = lazy(async () => ({
  default: (await import("./owner/approval-inbox-page")).ApprovalInboxPage,
}));
const SalesDeskPage = lazy(async () => ({
  default: (await import("./sales/sales-desk-page")).SalesDeskPage,
}));
const EstimatorWorkbenchPage = lazy(async () => ({
  default: (await import("./estimator/estimator-workbench-page")).EstimatorWorkbenchPage,
}));
const QuoteRevisionApprovalQueuePage = lazy(async () => ({
  default: (await import("./estimator/quote-revision-approval-page"))
    .QuoteRevisionApprovalQueuePage,
}));
const QuoteRevisionApprovalDetailPage = lazy(async () => ({
  default: (await import("./estimator/quote-revision-approval-page"))
    .QuoteRevisionApprovalDetailPage,
}));
const QuoteRevisionApprovalPreparePage = lazy(async () => ({
  default: (await import("./estimator/quote-revision-approval-page"))
    .QuoteRevisionApprovalPreparePage,
}));
const TodayPage = lazy(async () => ({
  default: (await import("./field/field-pages")).TodayPage,
}));
const JobPage = lazy(async () => ({
  default: (await import("./field/field-pages")).JobPage,
}));
const CheckInPage = lazy(async () => ({
  default: (await import("./field/field-pages")).CheckInPage,
}));

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

const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/pair",
  component: PairRoute,
});

function VerifyRoute() {
  const [token] = useState(() => takeMagicLinkTokenFromWindow());
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <MagicLinkConsume token={token} />
    </main>
  );
}

function PairRoute() {
  const [token] = useState(() => takePairingTokenFromWindow());
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <DevicePairingConsume token={token} />
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
  component: TodayRoute,
});

const jobRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/jobs/$jobId",
  component: JobRoute,
});

const checkInRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/check-in",
  component: CheckInRoute,
});

const jobCheckInRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/check-in/$jobId",
  component: CheckInRoute,
});

function TodayRoute() {
  return (
    <Suspense fallback={<FieldRouteSkeleton label="Loading assigned work" />}>
      <TodayPage />
    </Suspense>
  );
}

function JobRoute() {
  return (
    <Suspense fallback={<FieldRouteSkeleton label="Loading field packet" />}>
      <JobPage />
    </Suspense>
  );
}

function CheckInRoute() {
  return (
    <Suspense fallback={<FieldRouteSkeleton label="Loading field check-in" />}>
      <CheckInPage />
    </Suspense>
  );
}

function FieldRouteSkeleton({ label }: { label: string }) {
  return (
    <section className="mx-auto max-w-5xl space-y-6" aria-busy="true" aria-label={label}>
      <div className="h-11 w-28 bg-surface-muted/70" />
      <div className="border-b border-border pb-6">
        <div className="h-5 w-24 bg-surface-muted/70" />
        <div className="mt-3 h-11 max-w-lg bg-surface-muted/70" />
        <div className="mt-4 h-5 max-w-xl bg-surface-muted/70" />
      </div>
      <div className="h-44 border border-border bg-surface-muted/50" />
    </section>
  );
}

const ownerRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/owner",
  component: OwnerRoute,
});

const approvalsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/approvals",
  component: ApprovalsRoute,
});

function OwnerRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <OwnerNowPage />
    </Suspense>
  );
}

function ApprovalsRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <ApprovalInboxPage />
    </Suspense>
  );
}

function OwnerRouteSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading current decision queue"
    >
      <div className="h-20 border-b border-border bg-surface-muted/70" />
      <div className="grid border-y border-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-24 bg-surface-muted/60 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          />
        ))}
      </div>
    </section>
  );
}

const salesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/sales",
  component: SalesRoute,
});

const estimatorWorkbenchRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/estimator/jobs/$jobId",
  component: EstimatorWorkbenchRoute,
});

const quoteRevisionApprovalQueueRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/quote-revision-approvals",
  component: QuoteRevisionApprovalQueueRoute,
});

const quoteRevisionApprovalDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/quote-revision-approvals/$approvalId",
  component: QuoteRevisionApprovalDetailRoute,
});

const quoteRevisionApprovalPrepareRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/estimator/jobs/$jobId/revision",
  component: QuoteRevisionApprovalPrepareRoute,
});

function SalesRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <SalesDeskPage />
    </Suspense>
  );
}

function EstimatorWorkbenchRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <EstimatorWorkbenchPage />
    </Suspense>
  );
}

function QuoteRevisionApprovalQueueRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <QuoteRevisionApprovalQueuePage />
    </Suspense>
  );
}

function QuoteRevisionApprovalDetailRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <QuoteRevisionApprovalDetailPage />
    </Suspense>
  );
}

function QuoteRevisionApprovalPrepareRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <QuoteRevisionApprovalPreparePage />
    </Suspense>
  );
}

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  verifyRoute,
  pairRoute,
  portalRootRoute,
  portalRoute,
  authenticatedRoute.addChildren([
    todayRoute,
    jobRoute,
    checkInRoute,
    jobCheckInRoute,
    ownerRoute,
    approvalsRoute,
    salesRoute,
    estimatorWorkbenchRoute,
    quoteRevisionApprovalQueueRoute,
    quoteRevisionApprovalDetailRoute,
    quoteRevisionApprovalPrepareRoute,
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
