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
import { RoleGuard } from "./components/role-guard";
import { NotFoundPage } from "./pages/placeholders";

const loadCustomerPortalPage = () => import("./portal/customer-portal-page");
const CustomerPortalPage = lazy(async () => ({
  default: (await loadCustomerPortalPage()).CustomerPortalPage,
}));
const CustomerContractAcceptancePage = lazy(async () => ({
  default: (await import("./portal/customer-contract-acceptance-page"))
    .CustomerContractAcceptancePage,
}));
const PublicEstimatePage = lazy(async () => ({
  default: (await import("./public-estimate/public-estimate-page")).PublicEstimatePage,
}));
const NowPage = lazy(async () => ({
  default: (await import("./now/now-page")).NowPage,
}));

const OwnerNowPage = lazy(async () => ({
  default: (await import("./owner/owner-now-page")).OwnerNowPage,
}));
const ApprovalInboxPage = lazy(async () => ({
  default: (await import("./owner/approval-inbox-page")).ApprovalInboxPage,
}));
const SalesDeskPage = lazy(async () => ({
  default: (await import("./sales/sales-desk-page")).SalesDeskPage,
}));
const loadPipelineBoardPage = () => import("./pipeline/pipeline-board-page");
const SalesPipelineBoardPage = lazy(async () => ({
  default: (await loadPipelineBoardPage()).SalesPipelineBoardPage,
}));
const OwnerPipelineBoardPage = lazy(async () => ({
  default: (await loadPipelineBoardPage()).OwnerPipelineBoardPage,
}));
const ProductionRunwayPage = lazy(async () => ({
  default: (await import("./production/production-runway-page")).ProductionRunwayPage,
}));
const NewoOperationsPage = lazy(async () => ({
  default: (await import("./newo/newo-operations-page")).NewoOperationsPage,
}));
const ServiceDeskPage = lazy(async () => ({
  default: (await import("./service/service-desk-page")).ServiceDeskPage,
}));
const ServiceCasePage = lazy(async () => ({
  default: (await import("./service/service-case-page")).ServiceCasePage,
}));
const PostizPage = lazy(async () => ({
  default: (await import("./postiz/postiz-page")).PostizPage,
}));
const MoneyDeskPage = lazy(async () => ({
  default: (await import("./accounting/money-desk-page")).MoneyDeskPage,
}));
const MoneyIntentPage = lazy(async () => ({
  default: (await import("./accounting/money-intent-page")).MoneyIntentPage,
}));
const MoneyExceptionsPage = lazy(async () => ({
  default: (await import("./accounting/money-exceptions-page")).MoneyExceptionsPage,
}));
const QuickBooksSettingsPage = lazy(async () => ({
  default: (await import("./accounting/quickbooks-page")).QuickBooksSettingsPage,
}));
const QuickBooksFinalInvoicePage = lazy(async () => ({
  default: (await import("./accounting/quickbooks-page")).QuickBooksFinalInvoicePage,
}));
const FacetDesignPage = lazy(async () => ({
  default: (await import("./facet/facet-design-page")).FacetDesignPage,
}));
const SetupPage = lazy(async () => ({
  default: (await import("./admin/setup-page")).SetupPage,
}));
const CompanyProfilePage = lazy(async () => ({
  default: (await import("./admin/company-profile-page")).CompanyProfilePage,
}));
const TeamPage = lazy(async () => ({
  default: (await import("./admin/team-page")).TeamPage,
}));
const CrewDevicesPage = lazy(async () => ({
  default: (await import("./admin/crew-devices-page")).CrewDevicesPage,
}));
const IntegrationReadinessPage = lazy(async () => ({
  default: (await import("./integrations/integration-readiness-page")).IntegrationReadinessPage,
}));
const ConfigurationPage = lazy(async () => ({
  default: (await import("./admin/configuration-page")).ConfigurationPage,
}));
const PipelineConfigurationPage = lazy(async () => ({
  default: (await import("./admin/pipeline-configuration-page")).PipelineConfigurationPage,
}));
const SchemaFieldsConfigurationPage = lazy(async () => ({
  default: (await import("./admin/schema-fields-configuration-page")).SchemaFieldsConfigurationPage,
}));
const AutomationConfigurationPage = lazy(async () => ({
  default: (await import("./admin/automation-configuration-page")).AutomationConfigurationPage,
}));
const NewLeadPage = lazy(async () => ({
  default: (await import("./sales/new-lead-page")).NewLeadPage,
}));
const LeadTriagePreparePage = lazy(async () => ({
  default: (await import("./sales/lead-triage-prepare-page")).LeadTriagePreparePage,
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
const loadFieldPages = () => import("./field/field-pages");
const loadTodayPage = () => import("./field/today-page");
const TodayPage = lazy(async () => ({
  default: (await loadTodayPage()).TodayPage,
}));
const JobPage = lazy(async () => ({
  default: (await loadFieldPages()).JobPage,
}));
const WorkObjectPage = lazy(async () => ({
  default: (await loadFieldPages()).WorkObjectPage,
}));
const CheckInPage = lazy(async () => ({
  default: (await loadFieldPages()).CheckInPage,
}));
const loadFleetPage = () => import("./field/fleet-page");
const FleetPage = lazy(async () => ({
  default: (await loadFleetPage()).FleetPage,
}));
const InventoryPage = lazy(async () => ({
  default: (await import("./inventory/inventory-page")).InventoryPage,
}));

// Field Companion is the PWA's default entry point. Start loading its module while the
// session boundary verifies the device instead of serializing the authenticated read
// model behind a second route-bundle round trip. Other role surfaces remain lazy.
//
// The run sheet warms only its own module: the job packet, work object and check-in
// surfaces are five times its size, and `/today` cannot paint until whatever it warms
// has been evaluated.
if (typeof window !== "undefined") {
  const { pathname } = window.location;
  if (isTodayPath(pathname)) void loadTodayPage();
  // The vehicle rail is its own module. Warming the job packet for it would pay
  // for the largest field bundle to render a screen that never uses it.
  else if (isFleetPath(pathname)) void loadFleetPage();
  else if (isFieldPath(pathname)) void loadFieldPages();
}

function isTodayPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/today";
}

function isFieldPath(pathname: string): boolean {
  return (
    isTodayPath(pathname) ||
    pathname.startsWith("/jobs/") ||
    pathname.startsWith("/work-objects/") ||
    pathname.startsWith("/check-in")
  );
}

function isFleetPath(pathname: string): boolean {
  return pathname === "/vehicle" || pathname.startsWith("/vehicle/");
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/now" });
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
  component: CustomerPortalRoute,
});

const customerContractAcceptanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contract-accept",
  component: CustomerContractAcceptanceRoute,
});

const publicEstimateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/estimate",
  component: PublicEstimateRoute,
});

function PublicEstimateRoute() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-dvh place-items-center p-4" aria-busy="true">
          Opening the estimate form…
        </main>
      }
    >
      <PublicEstimatePage />
    </Suspense>
  );
}

function CustomerPortalRoute() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-dvh place-items-center p-4" aria-busy="true">
          Opening your private project portal…
        </main>
      }
    >
      <CustomerPortalPage />
    </Suspense>
  );
}

function CustomerContractAcceptanceRoute() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-dvh place-items-center p-4" aria-busy="true">
          Opening your contract confirmation…
        </main>
      }
    >
      <CustomerContractAcceptancePage />
    </Suspense>
  );
}

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authenticated",
  component: AuthenticatedLayout,
});

const nowRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/now",
  component: NowRoute,
});

function NowRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <NowPage />
    </Suspense>
  );
}

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

const workObjectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/work-objects/$workObjectType/$workObjectId/physical-contexts/$physicalContextType/$physicalContextId",
  component: WorkObjectRoute,
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

const fleetRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/vehicle",
  component: FleetRoute,
});

const inventoryRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/inventory",
  component: InventoryRoute,
});

function TodayRoute() {
  return (
    <RoleGuard surface="field">
      <Suspense fallback={<FieldRouteSkeleton label="Loading assigned work" />}>
        <TodayPage />
      </Suspense>
    </RoleGuard>
  );
}

function JobRoute() {
  return (
    <RoleGuard surface="job">
      <Suspense fallback={<FieldRouteSkeleton label="Loading this job" />}>
        <JobPage />
      </Suspense>
    </RoleGuard>
  );
}

function WorkObjectRoute() {
  return (
    <RoleGuard surface="field">
      <Suspense fallback={<FieldRouteSkeleton label="Loading this work" />}>
        <WorkObjectPage />
      </Suspense>
    </RoleGuard>
  );
}

function CheckInRoute() {
  return (
    <RoleGuard surface="field">
      <Suspense fallback={<FieldRouteSkeleton label="Loading check-in" />}>
        <CheckInPage />
      </Suspense>
    </RoleGuard>
  );
}

function FleetRoute() {
  return (
    <RoleGuard surface="fleet">
      <Suspense fallback={<FieldRouteSkeleton label="Loading your vehicle" />}>
        <FleetPage />
      </Suspense>
    </RoleGuard>
  );
}

function InventoryRoute() {
  return (
    <RoleGuard surface="inventory">
      <Suspense fallback={<FieldRouteSkeleton label="Loading inventory" />}>
        <InventoryPage />
      </Suspense>
    </RoleGuard>
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
      aria-label="Loading your work"
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

// The board is mounted per role app rather than as one shared `/pipelines` route with
// role filtering inside it (UX spec section 4): Sales gets its own pipeline, Owner and
// Operations get the switcher across all of them.
const salesPipelineBoardRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/sales/board",
  component: SalesPipelineBoardRoute,
});

const ownerPipelineBoardRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/owner/board",
  component: OwnerPipelineBoardRoute,
});

const productionRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/production",
  component: ProductionRoute,
});

const newoOperationsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/newo",
  component: NewoOperationsRoute,
});

const serviceDeskRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/service",
  component: ServiceDeskRoute,
});

const serviceCaseRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/service/$caseId",
  component: ServiceCaseRoute,
});

const postizIntentRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/marketing/postiz/$intentId",
  component: PostizIntentRoute,
});

// The money desk. `/accounting` is the accounting role's landing page (contract section 8.2), and
// the two child routes below are the screens it leads to. `/accounting/quickbooks` stays where it
// is: the connection is a setting, the desk is the work.
const moneyDeskRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/accounting",
  component: MoneyDeskRoute,
});

const moneyIntentRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/accounting/intents/$intentId",
  component: MoneyIntentRoute,
});

const moneyExceptionsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/accounting/exceptions",
  component: MoneyExceptionsRoute,
});

const quickBooksSettingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/accounting/quickbooks",
  component: QuickBooksSettingsRoute,
});

const quickBooksFinalInvoiceRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/accounting/quickbooks/final-invoices/$intentId",
  component: QuickBooksFinalInvoiceRoute,
});

const facetDesignsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/facet-designs",
  component: FacetDesignsRoute,
});

const estimatorWorkbenchRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/estimator/jobs/$jobId",
  component: EstimatorWorkbenchRoute,
});

const leadTriagePrepareRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/sales/leads/$leadId/triage",
  component: LeadTriagePrepareRoute,
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

function SalesPipelineBoardRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <SalesPipelineBoardPage />
    </Suspense>
  );
}

function OwnerPipelineBoardRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <OwnerPipelineBoardPage />
    </Suspense>
  );
}

function ProductionRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <ProductionRunwayPage />
    </Suspense>
  );
}

function NewoOperationsRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <NewoOperationsPage />
    </Suspense>
  );
}

function ServiceDeskRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <ServiceDeskPage />
    </Suspense>
  );
}

function PostizIntentRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <PostizPage />
    </Suspense>
  );
}

function ServiceCaseRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <ServiceCasePage />
    </Suspense>
  );
}

function MoneyDeskRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <MoneyDeskPage />
    </Suspense>
  );
}

function MoneyIntentRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <MoneyIntentPage />
    </Suspense>
  );
}

function MoneyExceptionsRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <MoneyExceptionsPage />
    </Suspense>
  );
}

function QuickBooksSettingsRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <QuickBooksSettingsPage />
    </Suspense>
  );
}

function QuickBooksFinalInvoiceRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <QuickBooksFinalInvoicePage />
    </Suspense>
  );
}

function FacetDesignsRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <FacetDesignPage />
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

function LeadTriagePrepareRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <LeadTriagePreparePage />
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

// Setup is a list, not a single screen: `/settings` used to be crew device pairing alone, which
// left company details and people with nowhere to live (ELEC-158 B3/B4).
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: SetupRoute,
});

const settingsCompanyRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/company",
  component: CompanyProfileRoute,
});

const settingsTeamRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/team",
  component: TeamRoute,
});

const settingsDevicesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/devices",
  component: CrewDevicesRoute,
});

const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/integrations",
  component: IntegrationReadinessRoute,
});

const settingsConfigurationRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/configuration",
  component: ConfigurationRoute,
});

const settingsConfigurationPipelinesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/configuration/pipelines",
  component: PipelineConfigurationRoute,
});

const settingsConfigurationFieldsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/configuration/fields",
  component: SchemaFieldsConfigurationRoute,
});

const settingsConfigurationAutomationsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/configuration/automations",
  component: AutomationConfigurationRoute,
});

const newLeadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/sales/new-lead",
  component: NewLeadRoute,
});

function SetupRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <SetupPage />
    </Suspense>
  );
}

function CompanyProfileRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <CompanyProfilePage />
    </Suspense>
  );
}

function TeamRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <TeamPage />
    </Suspense>
  );
}

function CrewDevicesRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <CrewDevicesPage />
    </Suspense>
  );
}

function IntegrationReadinessRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <IntegrationReadinessPage />
    </Suspense>
  );
}

function ConfigurationRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <ConfigurationPage />
    </Suspense>
  );
}

function PipelineConfigurationRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <PipelineConfigurationPage />
    </Suspense>
  );
}

function SchemaFieldsConfigurationRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <SchemaFieldsConfigurationPage />
    </Suspense>
  );
}

function AutomationConfigurationRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <AutomationConfigurationPage />
    </Suspense>
  );
}

function NewLeadRoute() {
  return (
    <Suspense fallback={<OwnerRouteSkeleton />}>
      <NewLeadPage />
    </Suspense>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  verifyRoute,
  pairRoute,
  portalRootRoute,
  customerContractAcceptanceRoute,
  publicEstimateRoute,
  authenticatedRoute.addChildren([
    nowRoute,
    todayRoute,
    jobRoute,
    workObjectRoute,
    checkInRoute,
    jobCheckInRoute,
    fleetRoute,
    inventoryRoute,
    ownerRoute,
    approvalsRoute,
    newoOperationsRoute,
    serviceDeskRoute,
    serviceCaseRoute,
    postizIntentRoute,
    moneyDeskRoute,
    moneyIntentRoute,
    moneyExceptionsRoute,
    quickBooksSettingsRoute,
    quickBooksFinalInvoiceRoute,
    facetDesignsRoute,
    productionRoute,
    salesRoute,
    salesPipelineBoardRoute,
    ownerPipelineBoardRoute,
    newLeadRoute,
    leadTriagePrepareRoute,
    estimatorWorkbenchRoute,
    quoteRevisionApprovalQueueRoute,
    quoteRevisionApprovalDetailRoute,
    quoteRevisionApprovalPrepareRoute,
    settingsRoute,
    settingsCompanyRoute,
    settingsTeamRoute,
    settingsDevicesRoute,
    settingsIntegrationsRoute,
    settingsConfigurationRoute,
    settingsConfigurationPipelinesRoute,
    settingsConfigurationFieldsRoute,
    settingsConfigurationAutomationsRoute,
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
