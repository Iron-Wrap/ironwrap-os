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
  approvals: "/api/v1/approvals",
  approvalApprove: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`,
  approvalReject: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`,
  approvalReconcile: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reconcile`,
} as const;
