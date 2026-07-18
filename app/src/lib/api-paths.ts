export const API_PATHS = {
  publicInstantEstimateConfig: "/public/instant-estimate/config",
  publicInstantEstimate: "/public/instant-estimate",
  session: "/api/v1/session",
  fieldBootstrap: "/api/v1/field/bootstrap",
  magicLinkRequest: "/api/v1/auth/magic-link/request",
  magicLinkConsume: "/api/v1/auth/magic-link/consume",
  devicePairingConsume: "/api/v1/auth/device-pairing/consume",
  customerPortalResolve: "/api/v1/customer-portal/resolve",
  customerPortalLinks: "/api/v1/customer-portal/links",
  customerPortalLinkRevoke: (linkId: string) =>
    `/api/v1/customer-portal/links/${encodeURIComponent(linkId)}/revoke`,
  fieldUsers: "/api/v1/field-users",
  devicePairings: "/api/v1/device-pairings",
  devicePairingRevoke: (deviceId: string) =>
    `/api/v1/device-pairings/${encodeURIComponent(deviceId)}/revoke`,
  logout: "/api/v1/auth/logout",
  ownerMeasurementIntakeExceptions: "/api/v1/owner/measurement-intake-exceptions",
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
  quoteRevisionApprovals: "/api/v1/quote-revision-approvals",
  quoteRevisionApproval: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}`,
  quoteRevisionApprovalApprove: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}/approve`,
  quoteRevisionApprovalReject: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}/reject`,
  quoteRevisionApprovalReconcile: (approvalId: string) =>
    `/api/v1/quote-revision-approvals/${encodeURIComponent(approvalId)}/reconcile`,
  approvals: "/api/v1/approvals",
  approvalLeadTriagePrepare: "/api/v1/approvals/lead-triage",
  approvalApprove: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`,
  approvalReject: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`,
  approvalReconcile: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reconcile`,
} as const;
