export const API_PATHS = {
  publicInstantEstimateConfig: "/public/instant-estimate/config",
  publicInstantEstimate: "/public/instant-estimate",
  session: "/api/v1/session",
  inventoryOverview: "/api/v1/inventory/overview",
  inventoryLookup: "/api/v1/inventory/lookup",
  inventoryScans: "/api/v1/inventory/scans",
  inventoryCommands: "/api/v1/inventory/commands",
  now: "/api/v1/now",
  operatingIntake: "/api/v1/operating-intake",
  fieldBootstrap: "/api/v1/field/bootstrap",
  magicLinkRequest: "/api/v1/auth/magic-link/request",
  magicLinkConsume: "/api/v1/auth/magic-link/consume",
  devicePairingConsume: "/api/v1/auth/device-pairing/consume",
  hermesDesktopPairings: "/api/v1/hermes/desktop-pairings",
  customerPortalResolve: "/api/v1/customer-portal/resolve",
  customerPortalAcceptanceChallenge: "/api/v1/customer-portal/acceptance/challenge",
  customerPortalAcceptanceConfirm: "/api/v1/customer-portal/acceptance/confirm",
  customerPortalDecision: "/api/v1/customer-portal/decision",
  customerPortalLinks: "/api/v1/customer-portal/links",
  customerPortalLinkRevoke: (linkId: string) =>
    `/api/v1/customer-portal/links/${encodeURIComponent(linkId)}/revoke`,
  fieldUsers: "/api/v1/field-users",
  // Onboarding: the screens that let an owner set up their own company without an engineer.
  adminAppUsers: "/api/v1/admin/app-users",
  adminCompanyProfile: "/api/v1/admin/company-profile",
  adminCompanyLogo: "/api/v1/admin/company-profile/logo",
  companyLogo: "/public/company-logo",
  salesLeads: "/api/v1/sales/leads",
  devicePairings: "/api/v1/device-pairings",
  devicePairingRevoke: (deviceId: string) =>
    `/api/v1/device-pairings/${encodeURIComponent(deviceId)}/revoke`,
  logout: "/api/v1/auth/logout",
  ownerRuntime: "/api/v1/owner/runtime",
  ownerMeasurementIntakeExceptions: "/api/v1/owner/measurement-intake-exceptions",
  facetDesignEvidence: "/api/v1/facet-design-evidence",
  newoOperations: "/api/v1/newo/operations",
  postizConnect: "/api/v1/postiz/connect",
  postizIntent: (intentId: string) => `/api/v1/postiz/intents/${encodeURIComponent(intentId)}`,
  postizIntentApprove: (intentId: string) =>
    `/api/v1/postiz/intents/${encodeURIComponent(intentId)}/approve`,
  postizIntentReject: (intentId: string) =>
    `/api/v1/postiz/intents/${encodeURIComponent(intentId)}/reject`,
  postizIntentStop: (intentId: string) =>
    `/api/v1/postiz/intents/${encodeURIComponent(intentId)}/stop`,
  postizIntentReconcile: (intentId: string) =>
    `/api/v1/postiz/intents/${encodeURIComponent(intentId)}/reconcile`,
  // The money desk (IRO-52 slice S8). Deliberately a separate path space from the QuickBooks
  // connection routes above: one is the provider link, the other is the money.
  accountingSummary: "/api/v1/accounting/summary",
  accountingIntents: "/api/v1/accounting/intents",
  accountingIntent: (intentId: string) =>
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}`,
  accountingIntentApprove: (intentId: string) =>
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/approve`,
  accountingIntentReject: (intentId: string) =>
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/reject`,
  accountingIntentReconcile: (intentId: string) =>
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/reconcile`,
  accountingIntentCompensate: (intentId: string) =>
    `/api/v1/accounting/intents/${encodeURIComponent(intentId)}/compensate`,
  accountingExceptions: "/api/v1/accounting/exceptions",
  accountingExceptionResolve: (exceptionId: string) =>
    `/api/v1/accounting/exceptions/${encodeURIComponent(exceptionId)}/resolve`,
  quickBooksConnect: "/api/v1/quickbooks/connect",
  quickBooksConnection: "/api/v1/quickbooks/connection",
  quickBooksDisconnect: "/api/v1/quickbooks/disconnect",
  quickBooksFinalInvoiceMappings: "/api/v1/quickbooks/final-invoice-mappings",
  quickBooksFinalInvoice: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}`,
  quickBooksFinalInvoiceApprove: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}/approve`,
  quickBooksFinalInvoiceReject: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}/reject`,
  quickBooksFinalInvoiceReconcile: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}/reconcile`,
  production: "/api/v1/production",
  productionJobSchedule: (jobId: string) => `/api/v1/jobs/${encodeURIComponent(jobId)}/schedule`,
  productionGateClearance: (jobId: string, gate: string) =>
    `/api/v1/production/jobs/${encodeURIComponent(jobId)}/gates/${encodeURIComponent(gate)}/clearance`,
  sales: "/api/v1/sales",
  commercialLeadTriageDecisions: "/api/v1/commercial/lead-triage-decisions",
  estimatorJob: (jobId: string) => `/api/v1/estimator/jobs/${encodeURIComponent(jobId)}`,
  estimatorFacetLaunch: (jobId: string) =>
    `/api/v1/estimator/jobs/${encodeURIComponent(jobId)}/facet-launches`,
  proposalPublicationApprovals: "/api/v1/proposal-publication-approvals",
  proposalPublicationApproval: (approvalId: string) =>
    `/api/v1/proposal-publication-approvals/${encodeURIComponent(approvalId)}`,
  proposalPublicationApprovalApprove: (approvalId: string) =>
    `/api/v1/proposal-publication-approvals/${encodeURIComponent(approvalId)}/approve`,
  proposalPublicationApprovalReject: (approvalId: string) =>
    `/api/v1/proposal-publication-approvals/${encodeURIComponent(approvalId)}/reject`,
  proposalPublicationApprovalReconcile: (approvalId: string) =>
    `/api/v1/proposal-publication-approvals/${encodeURIComponent(approvalId)}/reconcile`,
  quoteRevisionApprovals: "/api/v1/quote-revision-approvals",
  quoteRevisionApproval: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}`,
  quoteRevisionApprovalApprove: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}/approve`,
  quoteRevisionApprovalReject: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}/reject`,
  quoteRevisionApprovalReconcile: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}/reconcile`,
  serviceCases: "/api/v1/service-cases",
  serviceCase: (caseId: string) => `/api/v1/service-cases/${encodeURIComponent(caseId)}`,
  serviceCaseTriage: (caseId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/triage`,
  serviceCaseDiagnoses: (caseId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/diagnoses`,
  serviceCaseRemedies: (caseId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/remedies`,
  serviceCaseRemedyVerification: (caseId: string, remedyId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/remedies/${encodeURIComponent(remedyId)}/verification`,
  serviceCaseCustomerDecision: (caseId: string, remedyId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/remedies/${encodeURIComponent(remedyId)}/customer-decision`,
  serviceCaseClosure: (caseId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/closure`,
  serviceCaseReopen: (caseId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/reopen`,
  serviceCaseCostRecoveryClaims: (caseId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/cost-recovery-claims`,
  serviceCaseCostRecoveryReconcile: (caseId: string, claimId: string) =>
    `/api/v1/service-cases/${encodeURIComponent(caseId)}/cost-recovery-claims/${encodeURIComponent(claimId)}/reconcile`,
  approvals: "/api/v1/approvals",
  approvalLeadTriagePrepare: "/api/v1/approvals/lead-triage",
  approvalApprove: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`,
  approvalReject: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`,
  approvalReconcile: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reconcile`,
} as const;
