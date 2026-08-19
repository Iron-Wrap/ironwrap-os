export const API_PATHS = {
  publicInstantEstimateConfig: "/public/instant-estimate/config",
  publicInstantEstimate: "/public/instant-estimate",
  session: "/api/v1/session",
  now: "/api/v1/now",
  fieldBootstrap: "/api/v1/field/bootstrap",
  magicLinkRequest: "/api/v1/auth/magic-link/request",
  magicLinkConsume: "/api/v1/auth/magic-link/consume",
  devicePairingConsume: "/api/v1/auth/device-pairing/consume",
  hermesDesktopPairings: "/api/v1/hermes/desktop-pairings",
  customerPortalResolve: "/api/v1/customer-portal/resolve",
  customerPortalAcceptanceChallenge: "/api/v1/customer-portal/acceptance/challenge",
  customerPortalAcceptanceConfirm: "/api/v1/customer-portal/acceptance/confirm",
  customerPortalLinks: "/api/v1/customer-portal/links",
  customerPortalLinkRevoke: (linkId: string) =>
    `/api/v1/customer-portal/links/${encodeURIComponent(linkId)}/revoke`,
  fieldUsers: "/api/v1/field-users",
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
  quickBooksConnect: "/api/v1/quickbooks/connect",
  quickBooksConnection: "/api/v1/quickbooks/connection",
  quickBooksDisconnect: "/api/v1/quickbooks/disconnect",
  quickBooksFinalInvoice: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}`,
  quickBooksFinalInvoiceApprove: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}/approve`,
  quickBooksFinalInvoiceReject: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}/reject`,
  quickBooksFinalInvoiceReconcile: (intentId: string) =>
    `/api/v1/quickbooks/final-invoices/${encodeURIComponent(intentId)}/reconcile`,
  production: "/api/v1/production",
  productionScheduleApprovals: "/api/v1/production-schedule-approvals",
  productionScheduleApproval: (approvalId: string) =>
    `/api/v1/production-schedule-approvals/${encodeURIComponent(approvalId)}`,
  productionScheduleApprovalApprove: (approvalId: string) =>
    `/api/v1/production-schedule-approvals/${encodeURIComponent(approvalId)}/approve`,
  productionScheduleApprovalReject: (approvalId: string) =>
    `/api/v1/production-schedule-approvals/${encodeURIComponent(approvalId)}/reject`,
  productionScheduleApprovalReconcile: (approvalId: string) =>
    `/api/v1/production-schedule-approvals/${encodeURIComponent(approvalId)}/reconcile`,
  sales: "/api/v1/sales",
  estimatorJob: (jobId: string) => `/api/v1/estimator/jobs/${encodeURIComponent(jobId)}`,
  estimatorFacetLaunch: (jobId: string) =>
    `/api/v1/estimator/jobs/${encodeURIComponent(jobId)}/facet-launches`,
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
