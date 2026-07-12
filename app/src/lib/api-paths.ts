export const API_PATHS = {
  session: "/api/v1/session",
  magicLinkRequest: "/api/v1/auth/magic-link/request",
  magicLinkConsume: "/api/v1/auth/magic-link/consume",
  devicePairingConsume: "/api/v1/auth/device-pairing/consume",
  fieldUsers: "/api/v1/field-users",
  devicePairings: "/api/v1/device-pairings",
  devicePairingRevoke: (deviceId: string) =>
    `/api/v1/device-pairings/${encodeURIComponent(deviceId)}/revoke`,
  logout: "/api/v1/auth/logout",
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
  approvalApprove: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`,
  approvalReject: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`,
  approvalReconcile: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reconcile`,
} as const;
