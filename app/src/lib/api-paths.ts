export const API_PATHS = {
  publicInstantEstimateConfig: "/public/instant-estimate/config",
  publicInstantEstimate: "/public/instant-estimate",
  session: "/api/v1/session",
  // Whether a capability is absent, switched off, on-but-unconfigured or reachable, for the
  // capabilities this role can reach. Every authenticated role; a different question from
  // `integrationReadiness` below, which answers whether a rail has been PROVEN
  // (docs/CAPABILITY-SIGNAL-CONTRACT.md).
  capabilities: "/api/v1/capabilities",
  search: (query: string) => `/api/v1/search?q=${encodeURIComponent(query)}`,
  authorityRecords: "/api/v1/authority-records",
  authorityRecordReadbacks: (recordId: string) =>
    `/api/v1/authority-records/${encodeURIComponent(recordId)}/readbacks`,
  inventoryOverview: "/api/v1/inventory/overview",
  inventoryLookup: "/api/v1/inventory/lookup",
  inventoryScans: "/api/v1/inventory/scans",
  inventoryCommands: "/api/v1/inventory/commands",
  // One selected file at a time, scoped to the stock, service or safety action it supports.
  evidenceUploads: "/api/v1/evidence-uploads",
  // The bytes of one attached file, readable only through the stock, service or safety record
  // that linked it, and only by someone whose access still matches their sign-in.
  evidenceContent: (receiptId: string) =>
    `/api/v1/evidence-uploads/${encodeURIComponent(receiptId)}/content`,
  inventoryCommand: (commandId: string) =>
    `/api/v1/inventory/commands/${encodeURIComponent(commandId)}`,
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
  adminSetupProgress: "/api/v1/admin/setup-progress",
  adminPipelines: "/api/v1/admin/pipelines",
  adminPipeline: (pipelineId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}`,
  adminPipelineOrder: "/api/v1/admin/pipelines/order",
  adminPipelineCopy: (pipelineId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/copy`,
  adminPipelineRoles: (pipelineId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/roles`,
  adminPipelineStages: (pipelineId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/stages`,
  adminPipelineStageOrder: (pipelineId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/stages/order`,
  adminPipelineStage: (pipelineId: string, stageId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(stageId)}`,
  adminPipelineStageRemove: (pipelineId: string, stageId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(stageId)}/remove`,
  adminPipelineAutomationRules: (pipelineId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/automation-rules`,
  adminPipelineAutomationRuleRevisions: (pipelineId: string, ruleId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/automation-rules/${encodeURIComponent(ruleId)}/revisions`,
  // `/revisions` is how the RULE was configured over time. `/activity` is what the rule DID when
  // it fired - the dispatch outcomes `pipeline_stage_automation_invocations` already records.
  // Server half tracked separately (ELEC-203 handoff); the client treats its absence as "not
  // published yet" rather than as a healthy rule.
  adminPipelineAutomationRuleActivity: (pipelineId: string, ruleId: string) =>
    `/api/v1/admin/pipelines/${encodeURIComponent(pipelineId)}/automation-rules/${encodeURIComponent(ruleId)}/activity`,
  // Document templates: the administrator's authoring surface for the layouts the shop and the
  // crew open on a job, and the same rows the automation catalog offers as a document to generate.
  adminDocumentTemplates: "/api/v1/admin/document-templates",
  adminDocumentTemplate: (templateId: string) =>
    `/api/v1/admin/document-templates/${encodeURIComponent(templateId)}`,
  adminDocumentTemplateRevisions: (templateId: string) =>
    `/api/v1/admin/document-templates/${encodeURIComponent(templateId)}/revisions`,
  // Automation recipients: the tenant-administered catalog a rule's `recipient_ref` resolves
  // against. This is what replaced the `PIPELINE_AUTOMATION_RECIPIENTS_JSON` deploy secret, so
  // "add the shop" is a screen an owner opens rather than a secret an engineer rotates.
  adminAutomationRecipients: "/api/v1/admin/automation-recipients",
  adminAutomationRecipient: (recipientId: string) =>
    `/api/v1/admin/automation-recipients/${encodeURIComponent(recipientId)}`,
  adminAutomationRecipientRetire: (recipientId: string) =>
    `/api/v1/admin/automation-recipients/${encodeURIComponent(recipientId)}/retire`,
  adminAutomationRecipientRevisions: (recipientId: string) =>
    `/api/v1/admin/automation-recipients/${encodeURIComponent(recipientId)}/revisions`,
  adminSchemaFields: "/api/v1/admin/schema-fields",
  adminSchemaField: (fieldId: string) =>
    `/api/v1/admin/schema-fields/${encodeURIComponent(fieldId)}`,
  adminSchemaFieldRevisions: (fieldId: string) =>
    `/api/v1/admin/schema-fields/${encodeURIComponent(fieldId)}/revisions`,
  companyLogo: "/public/company-logo",
  manualMeasurements: (jobId: string) =>
    `/api/v1/estimator/jobs/${encodeURIComponent(jobId)}/manual-measurements`,
  salesLeads: "/api/v1/sales/leads",
  officeLeadCreate: "/api/v1/sales/leads?include_receipt=1",
  officeLeadReceipt: (requestId: string) =>
    `/api/v1/sales/intakes/${encodeURIComponent(requestId)}`,
  officeLeadResume: (requestId: string) =>
    `/api/v1/sales/intakes/${encodeURIComponent(requestId)}/resume`,
  salesLead: (leadId: string) => `/api/v1/sales/leads/${encodeURIComponent(leadId)}`,
  devicePairings: "/api/v1/device-pairings",
  devicePairingRevoke: (deviceId: string) =>
    `/api/v1/device-pairings/${encodeURIComponent(deviceId)}/revoke`,
  logout: "/api/v1/auth/logout",
  ownerRuntime: "/api/v1/owner/runtime",
  integrationReadiness: "/api/v1/integrations/readiness?profile=reference_journey",
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
  // Configurable pipeline boards (ELEC-155 "API route contract"). Generic on purpose:
  // no vertical is named in the path space, only pipelines, cards and transitions.
  pipelines: "/api/v1/pipelines",
  pipelineBoard: (pipelineId: string) =>
    `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/board`,
  pipelineCards: (pipelineId: string) =>
    `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/cards`,
  pipelineCardTransitions: (pipelineId: string, cardId: string) =>
    `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/cards/${encodeURIComponent(cardId)}/transitions`,
  pipelineCardTransitionUndo: (pipelineId: string, cardId: string, transitionId: string) =>
    `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/cards/${encodeURIComponent(cardId)}/transitions/${encodeURIComponent(transitionId)}/undo`,
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
  // The safety desk: the whole company's equipment and corrective actions, judged by the
  // release gate's own rules. Reads only; every change goes through its own safety command.
  safetyDesk: "/api/v1/safety/desk",
  approvals: "/api/v1/approvals",
  approvalLeadTriagePrepare: "/api/v1/approvals/lead-triage",
  approvalApprove: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`,
  approvalReject: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`,
  approvalReconcile: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/reconcile`,
} as const;
