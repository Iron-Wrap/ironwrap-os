import {
  buildOwnerNowReadModel,
  buildProductionRunwayReadModel,
  buildSalesReadModel,
  type OwnerNowReadModel,
  type ProductionRunwayReadModel,
  type SalesReadModel,
} from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  listFacetV2IntakeExceptions,
  listFacetV2WorkflowEvidence,
  type FacetV2IntakeException,
  type FacetV2WorkflowEvidence,
} from "./facet-v2-evidence.ts";
import {
  listPostizActionableIntents,
  type PostizIntentProjection,
} from "./postiz.ts";
import {
  listQuickBooksCandidateHolds,
  listQuickBooksFinalInvoiceActionable,
  type QuickBooksCandidateHoldProjection,
  type QuickBooksBlockerCode,
  type QuickBooksFinalInvoiceProjection,
  type QuickBooksFinalInvoiceState,
  type QuickBooksNextStep,
  type QuickBooksRejectionReason,
} from "./quickbooks-final-invoice.ts";

export type NowSourceId = "owner" | "postiz" | "quickbooks_final_invoices" | "facet" | "sales" | "production";
export type NowHref =
  "/owner" | "/facet-designs" | "/sales" | "/production" | "/approvals" | "/today" | "/settings" |
  "/accounting/quickbooks" |
  `/marketing/postiz/${string}` | `/accounting/quickbooks/final-invoices/${string}`;

export interface NowAction {
  id: string;
  label: string;
  kind: "navigate" | "refresh";
  href: NowHref | null;
  reason: string;
  citation_ids: string[];
}

export interface StandardNowCard {
  id: string;
  tone: "critical" | "warning" | "neutral" | "positive";
  eyebrow: string;
  title: string;
  detail: string;
  action: NowAction | null;
  citations: Array<{
    id: string;
    label: string;
    source: "owned_read_model";
    href: NowHref;
  }>;
}

export interface QuickBooksFinalInvoiceNowCard {
  kind: "quickbooks_final_invoice";
  id: string;
  tone: "attention" | "blocked" | "critical" | "muted";
  eyebrow: "QuickBooks final invoice";
  title: string;
  detail: string;
  job_id: string;
  currency: "CAD";
  final_balance: string;
  invoice_state: QuickBooksFinalInvoiceState;
  blocker_code: QuickBooksBlockerCode | null;
  rejection_reason: QuickBooksRejectionReason | null;
  next_step: QuickBooksNextStep;
  action: { label: "Review final invoice"; href: `/accounting/quickbooks/final-invoices/${string}` };
  citations: StandardNowCard["citations"];
}

export type NowCard = StandardNowCard | QuickBooksFinalInvoiceNowCard;

export interface NowReadModel {
  version: 1;
  role: "owner" | "ops" | "sales" | "production" | "accounting";
  read_model_generated_at: string;
  permissions: string[];
  allowed_actions: string[];
  sources: Array<{
    id: NowSourceId;
    state: "current" | "limited" | "unavailable";
    read_model_generated_at: string | null;
    stale_fields: string[];
  }>;
  ui: {
    schema_version: 1;
    state: "ready" | "empty" | "limited";
    title: string;
    explanation: string;
    sync_label: string;
    primary_action: NowAction | null;
    sections: Array<{
      id: string;
      title: string;
      summary: string;
      cards: NowCard[];
    }>;
  };
}

type SourceResult<T> = { ok: true; model: T } | { ok: false };

interface FacetNowReadModel {
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
  evidence: FacetV2WorkflowEvidence[];
  intake_exceptions: FacetV2IntakeException[];
}

interface PostizNowReadModel {
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
  intents: PostizIntentProjection[];
}

interface QuickBooksNowReadModel {
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
  intents: QuickBooksFinalInvoiceProjection[];
  holds: QuickBooksCandidateHoldProjection[];
}

export async function buildNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<NowReadModel> {
  if (auth.session.role === "accounting") {
    const [quickbooks] = await Promise.allSettled([
      buildQuickBooksNowReadModel(env, auth, now),
    ]);
    return projectAccountingNowReadModel(settled(quickbooks), now);
  }
  if (auth.session.role === "production") {
    const [production] = await Promise.allSettled([
      buildProductionRunwayReadModel(env, auth),
    ]);
    return projectProductionNowReadModel(settled(production), now);
  }
  if (auth.session.role === "sales") {
    const [sales] = await Promise.allSettled([buildSalesReadModel(env, auth)]);
    return projectSalesNowReadModel(settled(sales), now);
  }
  if (auth.session.role !== "owner" && auth.session.role !== "ops")
    throw new Error("office_scope_required");

  const [owner, facet, sales, production, postiz, quickbooks] = await Promise.allSettled([
    buildOwnerNowReadModel(env, auth, now),
    buildFacetNowReadModel(env, auth, now),
    buildSalesReadModel(env, auth),
    buildProductionRunwayReadModel(env, auth),
    auth.session.role === "owner"
      ? buildPostizNowReadModel(env, auth, now)
      : Promise.resolve(null),
    auth.session.role === "owner"
      ? buildQuickBooksNowReadModel(env, auth, now)
      : Promise.resolve(null),
  ]);

  return projectNowReadModel(
    auth.session.role,
    {
      owner: settled(owner),
      facet: settled(facet),
      sales: settled(sales),
      production: settled(production),
      ...(auth.session.role === "owner" && postiz.status === "fulfilled" && postiz.value
        ? { postiz: { ok: true as const, model: postiz.value } }
        : auth.session.role === "owner"
          ? { postiz: { ok: false as const } }
          : {}),
      ...(auth.session.role === "owner" && quickbooks.status === "fulfilled" && quickbooks.value
        ? { quickbooks_final_invoices: { ok: true as const, model: quickbooks.value } }
        : auth.session.role === "owner"
          ? { quickbooks_final_invoices: { ok: false as const } }
          : {}),
    },
    now,
  );
}

export function projectProductionNowReadModel(
  production: SourceResult<ProductionRunwayReadModel>,
  now = new Date(),
): NowReadModel {
  const cards = production.ok
    ? production.model.jobs
        .filter((job) => job.lane !== "scheduled")
        .slice(0, 8)
        .map(productionCard)
    : [];
  const source = sourceProjection("production", production);
  const unavailable = source.state === "unavailable";
  const limited = source.state !== "current";
  const primaryAction = unavailable
    ? refreshAction(
        "now:refresh-production",
        "Refresh production records",
        "The owned production source could not be checked, so IronWrap cannot safely rank the next job.",
      )
    : (cards[0]?.action ??
      navigateAction(
        "now:open-production",
        "Open production",
        "/production",
        "No production attention item was returned by the current bounded read.",
        [],
      ));

  return {
    version: 1,
    role: "production",
    read_model_generated_at: now.toISOString(),
    permissions: production.ok ? unique(production.model.permissions) : [],
    allowed_actions: production.ok
      ? unique(production.model.allowed_actions)
      : [],
    sources: [source],
    ui: {
      schema_version: 1,
      state: limited ? "limited" : cards.length > 0 ? "ready" : "empty",
      title: "What needs you now",
      explanation:
        "IronWrap shows the next verified production blocker or readiness exception. Resolve it, record the evidence, then return for the next job.",
      sync_label: limited
        ? "Production records are limited or unavailable. Missing work is not treated as clear."
        : "Production records are current for this view.",
      primary_action: primaryAction,
      sections: [
        {
          id: "production",
          title: "Keep work moving",
          summary:
            cards.length > 0
              ? `${cards.length} production job${cards.length === 1 ? "" : "s"} need attention`
              : "No production attention item was returned.",
          cards,
        },
        ...(unavailable
          ? [
              {
                id: "source-status",
                title: "Could not verify",
                summary:
                  "Production needs another read before its work can be treated as clear.",
                cards: [unavailableSourceCard("production")],
              },
            ]
          : []),
      ],
    },
  };
}

export function projectSalesNowReadModel(
  sales: SourceResult<SalesReadModel>,
  now = new Date(),
): NowReadModel {
  const cards = sales.ok
    ? sales.model.leads
        .filter((lead) => lead.attention.length > 0)
        .slice(0, 8)
        .map(salesCard)
    : [];
  const source = sourceProjection("sales", sales);
  const unavailable = source.state === "unavailable";
  const limited = source.state !== "current";
  const primaryAction = unavailable
    ? refreshAction(
        "now:refresh-sales",
        "Refresh sales records",
        "The owned sales source could not be checked, so IronWrap cannot safely rank the next lead.",
      )
    : (cards[0]?.action ??
      navigateAction(
        "now:open-sales",
        "Open sales",
        "/sales",
        "No sales attention item was returned by the current bounded read.",
        [],
      ));

  return {
    version: 1,
    role: "sales",
    read_model_generated_at: now.toISOString(),
    permissions: sales.ok ? unique(sales.model.permissions) : [],
    allowed_actions: sales.ok ? unique(sales.model.allowed_actions) : [],
    sources: [source],
    ui: {
      schema_version: 1,
      state: limited ? "limited" : cards.length > 0 ? "ready" : "empty",
      title: "What needs you now",
      explanation:
        "IronWrap shows the next verified sales or estimating exception. Open it, record the decision, then return for the next one.",
      sync_label: limited
        ? "Sales records are limited or unavailable. Missing work is not treated as clear."
        : "Sales records are current for this view.",
      primary_action: primaryAction,
      sections: [
        {
          id: "sales",
          title: "Move the next customer",
          summary:
            cards.length > 0
              ? `${cards.length} lead${cards.length === 1 ? "" : "s"} need attention`
              : "No sales attention item was returned.",
          cards,
        },
        ...(unavailable
          ? [
              {
                id: "source-status",
                title: "Could not verify",
                summary: "Sales needs another read before its work can be treated as clear.",
                cards: [unavailableSourceCard("sales")],
              },
            ]
          : []),
      ],
    },
  };
}

export function projectNowReadModel(
  role: "owner" | "ops",
  input: {
    owner: SourceResult<OwnerNowReadModel>;
    facet: SourceResult<FacetNowReadModel>;
    sales: SourceResult<SalesReadModel>;
    production: SourceResult<ProductionRunwayReadModel>;
    postiz?: SourceResult<PostizNowReadModel>;
    quickbooks_final_invoices?: SourceResult<QuickBooksNowReadModel>;
  },
  now = new Date(),
): NowReadModel {
  const ownerCards = input.owner.ok
    ? input.owner.model.exceptions.slice(0, 6).map(ownerCard)
    : [];
  const postizCards = role === "owner" && input.postiz?.ok
    ? input.postiz.model.intents.slice(0, 6).map(postizCard)
    : [];
  const quickBooksCards = role === "owner" && input.quickbooks_final_invoices?.ok
    ? [
        ...input.quickbooks_final_invoices.model.holds.map(quickBooksHoldCard),
        ...input.quickbooks_final_invoices.model.intents.map(quickBooksCard),
      ].slice(0, 6)
    : [];
  const productionCards = input.production.ok
    ? input.production.model.jobs
        .filter((job) => job.lane !== "scheduled")
        .slice(0, 5)
        .map(productionCard)
    : [];
  const facetCards = input.facet.ok
    ? [
      ...input.facet.model.intake_exceptions.map(facetIntakeExceptionCard),
      ...input.facet.model.evidence.map(facetCard),
    ].slice(0, 6)
    : [];
  const salesCards = input.sales.ok
    ? input.sales.model.leads
        .filter((lead) => lead.attention.length > 0)
        .slice(0, 5)
        .map(salesCard)
    : [];
  const activeSourceOrder = role === "owner"
    ? ([
        "owner",
        ...(input.quickbooks_final_invoices ? (["quickbooks_final_invoices"] as const) : []),
        ...(input.postiz ? (["postiz"] as const) : []),
        "facet",
        "production",
        "sales",
      ] as const)
    : sourceOrder;
  const failedSourceCards = activeSourceOrder.flatMap((id) =>
    input[id]?.ok ? [] : [unavailableSourceCard(id)],
  );
  const workCards = [...quickBooksCards, ...postizCards, ...ownerCards, ...facetCards, ...productionCards, ...salesCards];
  const sources = activeSourceOrder.map((id) => sourceProjection(id, input[id]!));
  const limited = sources.some((source) => source.state !== "current");
  const unavailable = sources.some((source) => source.state === "unavailable");
  const quickBooksPrimaryAction = quickBooksCards[0]
    ? quickBooksPrimaryNowAction(quickBooksCards[0])
    : null;
  const primaryAction = unavailable
    ? refreshAction(
        "now:refresh",
        "Refresh live records",
        "One or more owned sources could not be checked, so IronWrap cannot safely rank the next action.",
      )
    : (quickBooksPrimaryAction ??
      [...postizCards, ...ownerCards, ...facetCards, ...productionCards, ...salesCards][0]?.action ??
      navigateAction(
        "now:today",
        "Open today's work",
        "/today",
        "There are no blocking exceptions in the current bounded read.",
        [],
      ));

  return {
    version: 1,
    role,
    read_model_generated_at: now.toISOString(),
    permissions: unique(
      activeSourceOrder.flatMap((id) =>
        input[id]?.ok ? input[id].model.permissions : [],
      ),
    ),
    allowed_actions: unique(
      activeSourceOrder.flatMap((id) =>
        input[id]?.ok ? input[id].model.allowed_actions : [],
      ),
    ),
    sources,
    ui: {
      schema_version: 1,
      state: limited ? "limited" : workCards.length > 0 ? "ready" : "empty",
      title: "What needs you now",
      explanation:
        "IronWrap combines current owner, marketing, Facet, sales, and production exceptions here. Open the first item, make the decision, then come back for the next one.",
      sync_label: limited
        ? "Some live records are limited or unavailable. They are not treated as clear."
        : "Owner, Facet, sales, and production records are current for this view.",
      primary_action: primaryAction,
      sections: [
        {
          id: "exceptions",
          title: "Decide first",
          summary:
            quickBooksCards.length + postizCards.length + ownerCards.length > 0
              ? `${quickBooksCards.length + postizCards.length + ownerCards.length} highest-priority exception${quickBooksCards.length + postizCards.length + ownerCards.length === 1 ? "" : "s"}`
              : "No owner exception was returned by the current bounded read.",
          cards: [...quickBooksCards, ...postizCards, ...ownerCards],
        },
        {
          id: "facet",
          title: "Finish customer design reviews",
          summary:
            facetCards.length > 0
              ? `${facetCards.length} Facet design${facetCards.length === 1 ? "" : "s"} need the next verified step`
              : "No unfinished Facet design review was returned.",
          cards: facetCards,
        },
        {
          id: "production",
          title: "Keep work moving",
          summary:
            productionCards.length > 0
              ? `${productionCards.length} production job${productionCards.length === 1 ? "" : "s"} need attention`
              : "No production attention item was returned.",
          cards: productionCards,
        },
        {
          id: "sales",
          title: "Move the next customer",
          summary:
            salesCards.length > 0
              ? `${salesCards.length} lead${salesCards.length === 1 ? "" : "s"} need attention`
              : "No sales attention item was returned.",
          cards: salesCards,
        },
        ...(failedSourceCards.length > 0
          ? [
              {
                id: "source-status",
                title: "Could not verify",
                summary:
                  "These sources need another read before their work can be treated as clear.",
                cards: failedSourceCards,
              },
            ]
          : []),
      ],
    },
  };
}

const sourceOrder = ["owner", "facet", "production", "sales"] as const;

export function projectAccountingNowReadModel(
  quickbooks: SourceResult<QuickBooksNowReadModel>,
  now = new Date(),
): NowReadModel {
  const source = sourceProjection("quickbooks_final_invoices", quickbooks);
  const cards = quickbooks.ok
    ? [
        ...quickbooks.model.holds.map(quickBooksHoldCard),
        ...quickbooks.model.intents.map(quickBooksCard),
      ].slice(0, 8)
    : [];
  const unavailable = source.state === "unavailable";
  return {
    version: 1,
    role: "accounting",
    read_model_generated_at: now.toISOString(),
    permissions: quickbooks.ok ? quickbooks.model.permissions : [],
    allowed_actions: quickbooks.ok ? quickbooks.model.allowed_actions : [],
    sources: [source],
    ui: {
      schema_version: 1,
      state: unavailable ? "limited" : cards.length > 0 ? "ready" : "empty",
      title: "QuickBooks final invoices",
      explanation: "Review only immutable, accepted residential final-balance candidates and reconcile provider readback separately.",
      sync_label: unavailable
        ? "QuickBooks final-invoice state could not be checked and is not treated as clear."
        : "QuickBooks final-invoice records are current for this bounded view.",
      primary_action: unavailable
        ? refreshAction("quickbooks-final-invoices:refresh", "Refresh final invoices", "The bounded accounting read is unavailable.")
        : null,
      sections: [{
        id: "quickbooks-final-invoices",
        title: "Review and reconcile",
        summary: cards.length > 0 ? `${cards.length} final invoice${cards.length === 1 ? "" : "s"} need attention` : "No final invoice needs attention.",
        cards,
      }],
    },
  };
}

async function buildQuickBooksNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now: Date,
): Promise<QuickBooksNowReadModel> {
  if (!auth.permissions.includes("quickbooks:read")) throw new Error("quickbooks_read_required");
  const [intents, holds] = await Promise.all([
    listQuickBooksFinalInvoiceActionable(env, auth.session.tenant_id, 7),
    listQuickBooksCandidateHolds(env, auth.session.tenant_id, 7),
  ]);
  return {
    read_model_generated_at: now.toISOString(),
    stale_fields: intents.length > 6 || holds.length > 6 ? ["partial.quickbooks_final_invoices"] : [],
    permissions: auth.permissions.filter((permission) => permission.startsWith("quickbooks:")),
    allowed_actions: intents.length > 0 || holds.length > 0 ? ["quickbooks.final_invoice.review"] : [],
    intents: intents.slice(0, 6),
    holds: holds.slice(0, 6),
  };
}

async function buildPostizNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now: Date,
): Promise<PostizNowReadModel> {
  if (auth.session.role !== "owner") throw new Error("owner_role_required");
  const intents = await listPostizActionableIntents(env, auth.session.tenant_id, 7);
  return {
    read_model_generated_at: now.toISOString(),
    stale_fields: intents.length > 6 ? ["partial.postiz_intents"] : [],
    permissions: ["postiz:intent:read"],
    allowed_actions: intents.length > 0 ? ["postiz.intent.review"] : [],
    intents: intents.slice(0, 6),
  };
}

async function buildFacetNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now: Date,
): Promise<FacetNowReadModel> {
  if (!auth.permissions.includes("facet:read")) throw new Error("facet_read_required");
  const [evidenceResult, exceptionResult] = await Promise.all([
    listFacetV2WorkflowEvidence(env, auth.session.tenant_id, 51),
    listFacetV2IntakeExceptions(env, auth.session.tenant_id, 51),
  ]);
  const evidence = evidenceResult.slice(0, 50);
  const intakeExceptions = exceptionResult.slice(0, 50);
  return {
    read_model_generated_at: now.toISOString(),
    stale_fields: evidenceResult.length > evidence.length ||
        exceptionResult.length > intakeExceptions.length
      ? ["partial.facet_design_workflow"]
      : [],
    permissions: auth.permissions.filter((permission) => permission.startsWith("facet:")),
    allowed_actions: ["facet_design.read"],
    evidence,
    intake_exceptions: intakeExceptions,
  };
}

function settled<T>(result: PromiseSettledResult<T>): SourceResult<T> {
  return result.status === "fulfilled"
    ? { ok: true, model: result.value }
    : { ok: false };
}

function sourceProjection(
  id: NowSourceId,
  result: SourceResult<{
    read_model_generated_at: string;
    stale_fields: string[];
    partial_sources?: string[];
  }>,
): NowReadModel["sources"][number] {
  if (!result.ok)
    return {
      id,
      state: "unavailable" as const,
      read_model_generated_at: null,
      stale_fields: [],
    };
  const partialSources = result.model.partial_sources ?? [];
  const staleFields = unique([
    ...result.model.stale_fields,
    ...partialSources.map((source) => `partial.${source}`),
  ]);
  return {
    id,
    state: staleFields.length > 0 ? ("limited" as const) : ("current" as const),
    read_model_generated_at: result.model.read_model_generated_at,
    stale_fields: staleFields,
  };
}

function ownerCard(
  exception: OwnerNowReadModel["exceptions"][number],
): StandardNowCard {
  const href: NowHref =
    exception.kind === "untriaged_lead" ||
    exception.kind === "lead_triage_unknown"
      ? "/sales"
      : exception.kind.includes("approval")
        ? "/approvals"
        : "/owner";
  const citationId = `owner:${exception.id}`;
  const reason =
    exception.next_action ??
    exception.why ??
    "Review the source record and decide the safe next step.";
  return {
    id: citationId,
    tone: ownerTone(exception.severity),
    eyebrow: exception.kind.replaceAll("_", " "),
    title: exception.title,
    detail: exception.why ?? reason,
    action: navigateAction(citationId, "Review exception", href, reason, [
      citationId,
    ]),
    citations: [citation(citationId, "Owner exception record", href)],
  };
}

function productionCard(
  job: ProductionRunwayReadModel["jobs"][number],
): StandardNowCard {
  const citationId = `production:${job.id}`;
  const title = job.job_number ? `Job ${job.job_number}` : "Production job";
  return {
    id: citationId,
    tone:
      job.lane === "blocked"
        ? "critical"
        : job.lane === "ready_for_review"
          ? "positive"
          : "warning",
    eyebrow: job.lane.replaceAll("_", " "),
    title,
    detail: job.next_action,
    action: navigateAction(
      citationId,
      "Open production",
      "/production",
      job.next_action,
      [citationId],
    ),
    citations: [
      citation(citationId, `${title} production record`, "/production"),
    ],
  };
}

function salesCard(lead: SalesReadModel["leads"][number]): StandardNowCard {
  const citationId = `sales:${lead.id}`;
  const title =
    lead.contact.display_name ?? lead.job?.job_number ?? "Sales lead";
  const detail = lead.attention
    .map((item) => item.replaceAll("_", " "))
    .join("; ");
  return {
    id: citationId,
    tone: "warning",
    eyebrow: "sales attention",
    title,
    detail,
    action: navigateAction(citationId, "Open sales", "/sales", detail, [
      citationId,
    ]),
    citations: [citation(citationId, `${title} sales record`, "/sales")],
  };
}

function facetCard(evidence: FacetV2WorkflowEvidence): StandardNowCard {
  const citationId = `facet:${evidence.event_id}`;
  const next = evidence.projection_state === "awaiting_projection"
    ? "The exact signed decision is waiting for its automatic blank Draft projection."
    : evidence.projection_state === "projected"
      ? "The signed decision is reconciled to its blank Draft Quote Revision."
      : evidence.projection_state === "held"
        ? "This customer decision is held by its correction lifecycle and will not project."
        : "The signed identity, authority, or projection evidence needs operational review.";
  return {
    id: citationId,
    tone: evidence.projection_state === "projected"
      ? "positive"
      : evidence.projection_state === "attention_required"
        ? "critical"
        : evidence.projection_state === "held"
          ? "neutral"
          : "warning",
    eyebrow: "signed Facet v2 decision",
    title: `Facet project ${evidence.facet_project_id}`,
    detail: `${next} The projection is always a blank Draft and never changes approved commercial truth.`,
    action: navigateAction(citationId, "Review Facet evidence", "/facet-designs", next, [
      citationId,
    ]),
    citations: [
      citation(citationId, "Signed Facet v2 decision evidence", "/facet-designs"),
    ],
  };
}

function facetIntakeExceptionCard(exception: FacetV2IntakeException): StandardNowCard {
  const citationId = `facet-intake:${exception.event_id}`;
  const awaiting = exception.state === "awaiting_association";
  return {
    id: citationId,
    tone: awaiting ? "warning" : "critical",
    eyebrow: "Facet signed delivery",
    title: awaiting ? "Waiting for the exact project link" : "Signed delivery rejected",
    detail: awaiting
      ? "IronWrap is retrying the immutable delivery. Use the governed Facet launch path if it remains unassociated."
      : `IronWrap failed closed (${exception.status_code}); correct the source chain before reissue.`,
    action: navigateAction(
      `${citationId}:open`,
      "Review Facet recovery",
      "/facet-designs",
      "Inspect the signed intake state before a governed reissue.",
      [citationId],
    ),
    citations: [{
      id: citationId,
      label: "Signed Facet intake",
      source: "owned_read_model",
      href: "/facet-designs",
    }],
  };
}

function postizCard(intent: PostizIntentProjection): StandardNowCard {
  const citationId = `postiz:${intent.id}`;
  const href = `/marketing/postiz/${encodeURIComponent(intent.id)}` as const;
  const publicationDrift = intent.error_code?.startsWith("postiz_publication_drift_") ?? false;
  const detail = publicationDrift
    ? "A previously observed publication no longer matches exact-id readback. Reconcile manually; public retraction is not automated."
    : intent.state === "connection_required"
    ? `Connect ${intent.provider} before this intent can be submitted.`
    : intent.state === "pending_review"
      ? "Review the bounded draft and approve or reject it before any public submission."
      : intent.state === "stop_reconciliation_required"
        ? "The stop request is not proof the publish workflow ended. Reconciliation is required."
        : "Postiz submission or publication truth could not be verified. Reconcile by exact remote id.";
  return {
    id: citationId,
    tone: intent.state === "pending_review" ? "warning" : "critical",
    eyebrow: intent.state.replaceAll("_", " "),
    title: intent.title,
    detail,
    action: navigateAction(citationId, "Review marketing intent", href, detail, [citationId]),
    citations: [citation(citationId, "IronWrap marketing intent", href)],
  };
}

function quickBooksCard(intent: QuickBooksFinalInvoiceProjection): QuickBooksFinalInvoiceNowCard {
  const id = `qbo-final-invoice:${intent.intent_id}`;
  const href = `/accounting/quickbooks/final-invoices/${encodeURIComponent(intent.intent_id)}` as const;
  const nextStep = intent.blocker_next_step ??
    (intent.state === "connection_required" ? "connect_quickbooks" :
      intent.state === "blocked" || intent.state === "pending_review" || intent.state === "rejected" || intent.state === "failed"
        ? "refresh_candidate"
        : "reconcile_provider_invoice");
  const tone: QuickBooksFinalInvoiceNowCard["tone"] = intent.state === "failed" || intent.state === "reconciliation_required"
    ? "critical"
    : intent.state === "pending_review" || intent.state === "submission_pending" || intent.state === "submitted"
      ? "attention"
      : intent.state === "connection_required" || intent.state === "blocked"
        ? "blocked"
        : "muted";
  return {
    kind: "quickbooks_final_invoice",
    id,
    tone,
    eyebrow: "QuickBooks final invoice",
    title: `Final invoice ${intent.state.replaceAll("_", " ")}`,
    detail: `${intent.currency} ${intent.final_balance}`,
    job_id: intent.roof_job_id,
    currency: "CAD",
    final_balance: intent.final_balance,
    invoice_state: intent.state,
    blocker_code: intent.blocker_code,
    rejection_reason: intent.rejection_reason,
    next_step: nextStep,
    action: { label: "Review final invoice", href },
    citations: [{ id, label: "Final invoice intent", source: "owned_read_model", href }],
  };
}

function quickBooksPrimaryNowAction(
  card: QuickBooksFinalInvoiceNowCard | StandardNowCard,
): NowAction | null {
  if (!("kind" in card)) return card.action;
  return navigateAction(
    card.id,
    card.action.label,
    card.action.href,
    `Review this QuickBooks final-invoice ${card.invoice_state.replaceAll("_", " ")} exception before lower-priority work.`,
    card.citations.map((citation) => citation.id),
  );
}

function quickBooksHoldCard(hold: QuickBooksCandidateHoldProjection): StandardNowCard {
  const id = `qbo-final-invoice-hold:${hold.roof_job_id}:${hold.blocker_code}`;
  const href = "/accounting/quickbooks" as const;
  const detail = `${hold.blocker_code.replaceAll("_", " ")}. Correct the governed Frappe source before retrying discovery.`;
  return {
    id,
    tone: "critical",
    eyebrow: "QuickBooks candidate blocked",
    title: `Job ${hold.roof_job_id}`,
    detail,
    action: navigateAction(id, "Review QuickBooks setup", href, detail, [id]),
    citations: [citation(id, "QuickBooks candidate hold", href)],
  };
}

function unavailableSourceCard(id: NowSourceId): StandardNowCard {
  return {
    id: `source:${id}`,
    tone: "critical",
    eyebrow: "source unavailable",
    title: `${sourceLabel(id)} could not be checked`,
    detail:
      "IronWrap will not treat missing data as completed work. Refresh after the connection or source recovers.",
    action: refreshAction(
      `source:${id}:refresh`,
      "Try this read again",
      `${sourceLabel(id)} is unavailable.`,
    ),
    citations: [],
  };
}

function sourceLabel(id: NowSourceId): string {
  return id === "owner"
    ? "Owner exceptions"
    : id === "postiz"
      ? "Marketing intent"
    : id === "quickbooks_final_invoices"
      ? "QuickBooks final invoices"
    : id === "facet"
      ? "Facet design reviews"
    : id === "sales"
      ? "Sales"
      : "Production";
}

function ownerTone(severity: string | null): StandardNowCard["tone"] {
  const normalized = severity?.toLowerCase();
  if (normalized === "critical" || normalized === "high") return "critical";
  return "warning";
}

function navigateAction(
  id: string,
  label: string,
  href: NowHref,
  reason: string,
  citationIds: string[],
): NowAction {
  return {
    id: `${id}:action`,
    label,
    kind: "navigate",
    href,
    reason,
    citation_ids: citationIds,
  };
}

function refreshAction(id: string, label: string, reason: string): NowAction {
  return { id, label, kind: "refresh", href: null, reason, citation_ids: [] };
}

function citation(
  id: string,
  label: string,
  href: NowHref,
): StandardNowCard["citations"][number] {
  return { id, label, source: "owned_read_model", href };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
