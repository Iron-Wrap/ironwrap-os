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
  buildDecisionsReadModel,
  type DecisionPageRequest,
  type DecisionsReadModel,
} from "./decision-read-model.ts";
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

export type NowSourceId =
  | "owner"
  | "postiz"
  | "quickbooks_final_invoices"
  | "facet"
  | "sales"
  | "production";
export type NowHref =
  | "/owner"
  | "/facet-designs"
  | "/sales"
  | "/production"
  | "/approvals"
  | "/today"
  | "/settings"
  | "/accounting/quickbooks"
  | `/marketing/postiz/${string}`
  | `/accounting/quickbooks/final-invoices/${string}`;

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
  action: {
    label: "Review final invoice";
    href: `/accounting/quickbooks/final-invoices/${string}`;
  };
  citations: StandardNowCard["citations"];
}

export type NowCard = StandardNowCard | QuickBooksFinalInvoiceNowCard;

export interface NowReadModel {
  version: 1;
  role: "owner" | "ops" | "sales" | "production" | "accounting";
  read_model_generated_at: string;
  permissions: string[];
  allowed_actions: string[];
  decisions?: DecisionsReadModel;
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
  options?: { includeDecisions: boolean; page?: DecisionPageRequest },
): Promise<NowReadModel> {
  // Installed PWAs validate the original response strictly. Only opted-in
  // clients receive the additive projection; legacy reads retain their shape.
  if (!options?.includeDecisions) return buildRoleNowReadModel(env, auth, now);
  const [model, decisions] = await Promise.all([
    buildRoleNowReadModel(env, auth, now),
    buildDecisionsReadModel(env, auth, now, options.page),
  ]);
  return { ...model, decisions };
}

async function buildRoleNowReadModel(
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

  const [owner, facet, sales, production, postiz, quickbooks] =
    await Promise.allSettled([
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
      ...(auth.session.role === "owner" &&
      postiz.status === "fulfilled" &&
      postiz.value
        ? { postiz: { ok: true as const, model: postiz.value } }
        : auth.session.role === "owner"
          ? { postiz: { ok: false as const } }
          : {}),
      ...(auth.session.role === "owner" &&
      quickbooks.status === "fulfilled" &&
      quickbooks.value
        ? {
            quickbooks_final_invoices: {
              ok: true as const,
              model: quickbooks.value,
            },
          }
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
        "Check the job list again",
        "The job list did not load, so IronWrap cannot pick the next job yet.",
      )
    : (cards[0]?.action ??
      navigateAction(
        "now:open-production",
        "Open jobs",
        "/production",
        "No job needs a check in this list.",
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
      title: "Work to do now",
      explanation:
        "Start with the first item. Fix it, save proof, then come back for the next one.",
      sync_label: limited
        ? "Some job data is missing. IronWrap will not mark it as done."
        : "The job list is up to date.",
      primary_action: primaryAction,
      sections: [
        {
          id: "production",
          title: "Jobs to check",
          summary:
            cards.length > 0
              ? `${cards.length} job${cards.length === 1 ? "" : "s"} need a check`
              : "No job needs a check in this loaded list.",
          cards,
        },
        ...(unavailable
          ? [
              {
                id: "source-status",
                title: "List not ready",
                summary:
                  "Load the job list again before you mark work as done.",
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
        "Check the sales list again",
        "The sales list did not load, so IronWrap cannot pick the next customer yet.",
      )
    : (cards[0]?.action ??
      navigateAction(
        "now:open-sales",
        "Open sales",
        "/sales",
        "No customer needs a check in this list.",
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
      title: "Work to do now",
      explanation:
        "Start with the first customer. Save your choice, then come back for the next one.",
      sync_label: limited
        ? "Some sales data is missing. IronWrap will not mark it as done."
        : "The sales list is up to date.",
      primary_action: primaryAction,
      sections: [
        {
          id: "sales",
          title: "Customers to help",
          summary:
            cards.length > 0
              ? `${cards.length} customer${cards.length === 1 ? "" : "s"} need a check`
              : "No customer needs a check in this loaded list.",
          cards,
        },
        ...(unavailable
          ? [
              {
                id: "source-status",
                title: "List not ready",
                summary:
                  "Load the sales list again before you mark work as done.",
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
  const postizCards =
    role === "owner" && input.postiz?.ok
      ? input.postiz.model.intents.slice(0, 6).map(postizCard)
      : [];
  const quickBooksCards =
    role === "owner" && input.quickbooks_final_invoices?.ok
      ? [
          ...input.quickbooks_final_invoices.model.holds.map(
            quickBooksHoldCard,
          ),
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
  const activeSourceOrder =
    role === "owner"
      ? ([
          "owner",
          ...(input.quickbooks_final_invoices
            ? (["quickbooks_final_invoices"] as const)
            : []),
          ...(input.postiz ? (["postiz"] as const) : []),
          "facet",
          "production",
          "sales",
        ] as const)
      : sourceOrder;
  const failedSourceCards = activeSourceOrder.flatMap((id) =>
    input[id]?.ok ? [] : [unavailableSourceCard(id)],
  );
  const workCards = [
    ...quickBooksCards,
    ...postizCards,
    ...ownerCards,
    ...facetCards,
    ...productionCards,
    ...salesCards,
  ];
  const sources = activeSourceOrder.map((id) =>
    sourceProjection(id, input[id]!),
  );
  const limited = sources.some((source) => source.state !== "current");
  const unavailable = sources.some((source) => source.state === "unavailable");
  const quickBooksPrimaryAction = quickBooksCards[0]
    ? quickBooksPrimaryNowAction(quickBooksCards[0])
    : null;
  const primaryAction = unavailable
    ? refreshAction(
        "now:refresh",
        "Check all lists again",
        "One or more work lists did not load, so IronWrap cannot pick the next step yet.",
      )
    : (quickBooksPrimaryAction ??
      [
        ...postizCards,
        ...ownerCards,
        ...facetCards,
        ...productionCards,
        ...salesCards,
      ][0]?.action ??
      navigateAction(
        "now:today",
        "Open today's work",
        "/today",
        "No item is blocking work right now.",
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
      title: "Work to do now",
      explanation:
        "IronWrap puts the most important work here. Start with the first item, finish it, then come back.",
      sync_label: limited
        ? "Some lists did not load or may be missing items. IronWrap will not mark them as done."
        : "All work lists are up to date.",
      primary_action: primaryAction,
      sections: [
        {
          id: "exceptions",
          title: "Check first",
          summary:
            quickBooksCards.length + postizCards.length + ownerCards.length > 0
              ? `${quickBooksCards.length + postizCards.length + ownerCards.length} item${quickBooksCards.length + postizCards.length + ownerCards.length === 1 ? "" : "s"} need a check`
              : "No item needs a check in this loaded list.",
          cards: [...quickBooksCards, ...postizCards, ...ownerCards],
        },
        {
          id: "facet",
          title: "Check Facet designs",
          summary:
            facetCards.length > 0
              ? `${facetCards.length} Facet design${facetCards.length === 1 ? "" : "s"} need a check`
              : "No Facet design needs a check in this loaded list.",
          cards: facetCards,
        },
        {
          id: "production",
          title: "Keep jobs moving",
          summary:
            productionCards.length > 0
              ? `${productionCards.length} job${productionCards.length === 1 ? "" : "s"} need a check`
              : "No job needs a check in this loaded list.",
          cards: productionCards,
        },
        {
          id: "sales",
          title: "Help the next customer",
          summary:
            salesCards.length > 0
              ? `${salesCards.length} customer${salesCards.length === 1 ? "" : "s"} need a check`
              : "No customer needs a check in this loaded list.",
          cards: salesCards,
        },
        ...(failedSourceCards.length > 0
          ? [
              {
                id: "source-status",
                title: "Lists not ready",
                summary: "Load these lists again before you mark work as done.",
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
      title: "Final invoices",
      explanation:
        "Check each final invoice. Make sure the amount is right and QuickBooks has the same record.",
      sync_label: unavailable
        ? "The QuickBooks invoice list did not load. IronWrap will not mark any invoice as done."
        : "The QuickBooks invoice list is up to date.",
      primary_action: unavailable
        ? refreshAction(
            "quickbooks-final-invoices:refresh",
            "Check invoices again",
            "The invoice list did not load.",
          )
        : null,
      sections: [
        {
          id: "quickbooks-final-invoices",
          title: "Invoices to check",
          summary:
            cards.length > 0
              ? `${cards.length} final invoice${cards.length === 1 ? "" : "s"} need a check`
              : "No final invoice needs a check in this loaded list.",
          cards,
        },
      ],
    },
  };
}

async function buildQuickBooksNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now: Date,
): Promise<QuickBooksNowReadModel> {
  if (!auth.permissions.includes("quickbooks:read"))
    throw new Error("quickbooks_read_required");
  const [intents, holds] = await Promise.all([
    listQuickBooksFinalInvoiceActionable(env, auth.session.tenant_id, 7),
    listQuickBooksCandidateHolds(env, auth.session.tenant_id, 7),
  ]);
  return {
    read_model_generated_at: now.toISOString(),
    stale_fields:
      intents.length > 6 || holds.length > 6
        ? ["partial.quickbooks_final_invoices"]
        : [],
    permissions: auth.permissions.filter((permission) =>
      permission.startsWith("quickbooks:"),
    ),
    allowed_actions:
      intents.length > 0 || holds.length > 0
        ? ["quickbooks.final_invoice.review"]
        : [],
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
  const intents = await listPostizActionableIntents(
    env,
    auth.session.tenant_id,
    7,
  );
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
  if (!auth.permissions.includes("facet:read"))
    throw new Error("facet_read_required");
  const [evidenceResult, exceptionResult] = await Promise.all([
    listFacetV2WorkflowEvidence(env, auth.session.tenant_id, 51),
    listFacetV2IntakeExceptions(env, auth.session.tenant_id, 51),
  ]);
  const evidence = evidenceResult.slice(0, 50);
  const intakeExceptions = exceptionResult.slice(0, 50);
  return {
    read_model_generated_at: now.toISOString(),
    stale_fields:
      evidenceResult.length > evidence.length ||
      exceptionResult.length > intakeExceptions.length
        ? ["partial.facet_design_workflow"]
        : [],
    permissions: auth.permissions.filter((permission) =>
      permission.startsWith("facet:"),
    ),
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
    "Open the work record and choose the next safe step.";
  return {
    id: citationId,
    tone: ownerTone(exception.severity),
    eyebrow:
      ownerTone(exception.severity) === "critical"
        ? "Fix first"
        : "Needs a check",
    title: exception.title,
    detail: exception.why ?? reason,
    action: navigateAction(citationId, "Open item", href, reason, [citationId]),
    citations: [citation(citationId, "Work record", href)],
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
    eyebrow:
      job.lane === "blocked"
        ? "Job blocked"
        : job.lane === "ready_for_review"
          ? "Ready to check"
          : "Job needs a check",
    title,
    detail: job.next_action,
    action: navigateAction(
      citationId,
      "Open job",
      "/production",
      job.next_action,
      [citationId],
    ),
    citations: [citation(citationId, `${title} record`, "/production")],
  };
}

function salesCard(lead: SalesReadModel["leads"][number]): StandardNowCard {
  const citationId = `sales:${lead.id}`;
  const title =
    lead.contact.display_name ?? lead.job?.job_number ?? "Sales lead";
  const detail = lead.attention.map(salesAttentionLabel).join(" ");
  return {
    id: citationId,
    tone: "warning",
    eyebrow: "Sales",
    title,
    detail,
    action: navigateAction(citationId, "Open customer", "/sales", detail, [
      citationId,
    ]),
    citations: [citation(citationId, "Customer record", "/sales")],
  };
}

function facetCard(evidence: FacetV2WorkflowEvidence): StandardNowCard {
  const citationId = `facet:${evidence.event_id}`;
  const next =
    evidence.projection_state === "awaiting_projection"
      ? "The signed choice is waiting for its native design projection."
      : evidence.projection_state === "projected"
        ? "The signed choice is recorded as native design authority."
        : evidence.projection_state === "held"
          ? "This signed choice is on hold and will not change the accepted design."
          : "The signed choice needs a check.";
  return {
    id: citationId,
    tone:
      evidence.projection_state === "projected"
        ? "positive"
        : evidence.projection_state === "attention_required"
          ? "critical"
          : evidence.projection_state === "held"
            ? "neutral"
            : "warning",
    eyebrow: "Signed Facet choice",
    title: `Facet project ${evidence.facet_project_id}`,
    detail: `${next} Any new quote starts blank. It cannot change the price the customer signed.`,
    action: navigateAction(
      citationId,
      "Open Facet design",
      "/facet-designs",
      next,
      [citationId],
    ),
    citations: [citation(citationId, "Signed Facet choice", "/facet-designs")],
  };
}

function facetIntakeExceptionCard(
  exception: FacetV2IntakeException,
): StandardNowCard {
  const citationId = `facet-intake:${exception.event_id}`;
  const awaiting = exception.state === "awaiting_association";
  return {
    id: citationId,
    tone: awaiting ? "warning" : "critical",
    eyebrow: "Facet file",
    title: awaiting
      ? "Waiting for the right project link"
      : "Signed file stopped",
    detail: awaiting
      ? "IronWrap is trying again. If it still fails, open the Facet design from IronWrap."
      : "IronWrap stopped this file to keep the wrong job from changing. Fix the link before you send it again.",
    action: navigateAction(
      `${citationId}:open`,
      "Fix Facet link",
      "/facet-designs",
      "Check why the signed choice did not reach the right job.",
      [citationId],
    ),
    citations: [
      {
        id: citationId,
        label: "Facet file",
        source: "owned_read_model",
        href: "/facet-designs",
      },
    ],
  };
}

function postizCard(intent: PostizIntentProjection): StandardNowCard {
  const citationId = `postiz:${intent.id}`;
  const href = `/marketing/postiz/${encodeURIComponent(intent.id)}` as const;
  const publicationDrift =
    intent.error_code?.startsWith("postiz_publication_drift_") ?? false;
  const detail = publicationDrift
    ? "A live post no longer matches our saved record. Check it by hand. IronWrap will not remove a public post on its own."
    : intent.state === "connection_required"
      ? `Link ${intent.provider} before this post can be sent.`
      : intent.state === "pending_review"
        ? "Check the draft. Then choose to send it or stop it."
        : intent.state === "stop_reconciliation_required"
          ? "The stop request did not prove the post stopped. Check the live post."
          : "IronWrap could not check if the post was sent. Check the live post by its ID.";
  return {
    id: citationId,
    tone: intent.state === "pending_review" ? "warning" : "critical",
    eyebrow: "Marketing",
    title: intent.title,
    detail,
    action: navigateAction(citationId, "Open post", href, detail, [citationId]),
    citations: [citation(citationId, "Marketing post", href)],
  };
}

function quickBooksCard(
  intent: QuickBooksFinalInvoiceProjection,
): QuickBooksFinalInvoiceNowCard {
  const id = `qbo-final-invoice:${intent.intent_id}`;
  const href =
    `/accounting/quickbooks/final-invoices/${encodeURIComponent(intent.intent_id)}` as const;
  const nextStep =
    intent.blocker_next_step ??
    (intent.state === "connection_required"
      ? "connect_quickbooks"
      : intent.state === "blocked" ||
          intent.state === "pending_review" ||
          intent.state === "rejected" ||
          intent.state === "failed"
        ? "refresh_candidate"
        : "reconcile_provider_invoice");
  const tone: QuickBooksFinalInvoiceNowCard["tone"] =
    intent.state === "failed" || intent.state === "reconciliation_required"
      ? "critical"
      : intent.state === "pending_review" ||
          intent.state === "submission_pending" ||
          intent.state === "submitted"
        ? "attention"
        : intent.state === "connection_required" || intent.state === "blocked"
          ? "blocked"
          : "muted";
  return {
    kind: "quickbooks_final_invoice",
    id,
    tone,
    eyebrow: "QuickBooks final invoice",
    title: "Final invoice needs a check",
    detail: `${intent.currency} ${intent.final_balance}`,
    job_id: intent.roof_job_id,
    currency: "CAD",
    final_balance: intent.final_balance,
    invoice_state: intent.state,
    blocker_code: intent.blocker_code,
    rejection_reason: intent.rejection_reason,
    next_step: nextStep,
    action: { label: "Review final invoice", href },
    citations: [
      { id, label: "Final invoice record", source: "owned_read_model", href },
    ],
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
    "Check this final invoice before other work.",
    card.citations.map((citation) => citation.id),
  );
}

function quickBooksHoldCard(
  hold: QuickBooksCandidateHoldProjection,
): StandardNowCard {
  const id = `qbo-final-invoice-hold:${hold.roof_job_id}:${hold.blocker_code}`;
  const href = "/accounting/quickbooks" as const;
  const detail = `${hold.blocker_code.replaceAll("_", " ")}. Fix the source record before you check for the invoice again.`;
  return {
    id,
    tone: "critical",
    eyebrow: "Final invoice blocked",
    title: `Job ${hold.roof_job_id}`,
    detail,
    action: navigateAction(id, "Open QuickBooks", href, detail, [id]),
    citations: [citation(id, "Invoice check", href)],
  };
}

function unavailableSourceCard(id: NowSourceId): StandardNowCard {
  return {
    id: `source:${id}`,
    tone: "critical",
    eyebrow: "List not ready",
    title: `${sourceLabel(id)} could not be checked`,
    detail:
      "IronWrap will not mark missing work as done. Try again when the list is back.",
    action: refreshAction(
      `source:${id}:refresh`,
      "Try again",
      `${sourceLabel(id)} did not load.`,
    ),
    citations: [],
  };
}

function sourceLabel(id: NowSourceId): string {
  return id === "owner"
    ? "Owner work"
    : id === "postiz"
      ? "Marketing"
      : id === "quickbooks_final_invoices"
        ? "Invoices"
        : id === "facet"
          ? "Facet designs"
          : id === "sales"
            ? "Sales"
            : "Jobs";
}

function salesAttentionLabel(
  value: SalesReadModel["leads"][number]["attention"][number],
): string {
  return value === "triage_unresolved"
    ? "This new lead has not been checked."
    : value === "estimate_needs_review"
      ? "The estimate needs a check."
      : value === "quote_needs_review"
        ? "The quote needs a check."
        : "The quote is out of date.";
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
