/**
 * Generated views: the `ironwrap_view_spec_v1` document, its closed registries and its validator.
 *
 * What it is
 *   Ask IronWrap (the `orchestrator` face) answers a request with a plain cited answer or with a
 *   view spec: one JSON document that names one of six templates, fills the template's named slots
 *   with known components, binds every fact a person reads to a read model, and offers only catalog
 *   actions. A view spec is data, never code. The renderer interprets it against the frozen
 *   registries in this file and never treats model text as HTML, script, style, URL or route.
 *
 * Sources of truth
 *   Templates, slots, component kinds, props and density limits: design/system-v2/TEMPLATES.md.
 *   Actions, classes, owners and display names: docs/AI-TEAM-CONTRACT.md, through the generated
 *   catalog copy beside this file (`contract-catalog.ts`; build one with `catalogFromContractJson`).
 *   Read models: the Worker routes they name. An entry with `available: false`, and a planned param
 *   or field, is something TEMPLATES.md binds that the Worker does not serve yet; the validator
 *   refuses it with `read_model_unavailable` until Track A ships it and flips the entry.
 *
 * Who runs it
 *   The ask API validates every spec before returning it and records the issue codes on the run as
 *   `view_spec_invalid`. The gateway constrains model output with `viewSpecJsonSchema()`. The app
 *   validates again before drawing and, for an invalid spec, shows the plain cited answer or
 *   `viewSpecFallbackWords`. Issue codes go to System details only, never onto the page. Both sides
 *   run these exact bytes: workers-bus/src/agents/view-spec.ts is a generated copy of this file.
 *
 * Rules for this file
 *   No imports, no zod, no DOM and no Node APIs, and only erasable TypeScript syntax: it runs
 *   unchanged in the Worker, in the browser and under Node's type stripping. It never throws on a
 *   spec, whatever the input. Registries are frozen data, so a new template, prop or read-model
 *   field is a data edit here.
 *
 * Changing it (from app/)
 *   npm run view-spec         copy this file into workers-bus/src/agents/view-spec.ts
 *   npm run catalog           refresh contract-catalog.ts from docs/AI-TEAM-CONTRACT.md
 *   npm run view-spec:check   fail when the Worker copy is stale (catalog:check likewise)
 *   The app test suite runs both checks as well.
 *
 * Values a person reads
 *   Facts come only from bindings `{bind, path}` into a declared data entry, or from row fields
 *   `{field}` inside a bound collection; literals are labels only. Money is integer minor units with
 *   an ISO 4217 currency, counts are integers, times are ISO 8601 instants, and a value the read
 *   model cannot know arrives as not known with its reason; the renderer shows "Not known yet" and
 *   never a zero. `id` values are never drawn: they are action targets and link ids.
 *
 * Wire form
 *   The strict JSON Schema dialect has no unions, so `viewSpecJsonSchema()` describes the components
 *   of a slot as one object carrying every prop of every kind that slot accepts. Model output that
 *   follows it sets the props of other kinds to null, the slots the template does not use to null,
 *   and the params its read model does not take to null. The validator accepts exactly those nulls
 *   and nothing else, so both that form and the TEMPLATES.md examples (no fillers) validate.
 */

export const VIEW_SPEC_SCHEMA_ID = "ironwrap_view_spec_v1";

export type TemplateId = "list" | "record" | "comparison" | "report" | "timeline" | "schedule";
export type SlotName =
  "heading" | "status" | "summary" | "alerts" | "filters" | "body" | "side" | "empty";
export type ComponentKind =
  | "record_heading"
  | "status_line"
  | "summary_cells"
  | "macro_tile"
  | "key_values"
  | "list"
  | "table"
  | "comparison_columns"
  | "chart"
  | "timeline"
  | "schedule"
  | "receipt_rows"
  | "agent_lane"
  | "decision_links"
  | "fact_rows"
  | "approvals"
  | "alert"
  | "proposed_value"
  | "source_chips"
  | "text"
  | "filter_bar"
  | "empty_hint";
/** Where the view is drawn. Customer pages and the shop tablet take no generated view. */
export type Place = "office" | "crew" | "customer" | "glove";
/** How a bound value is drawn (TEMPLATES.md section 3), plus `id`, which is never drawn. */
export type ValueType =
  | "text"
  | "money"
  | "count"
  | "percent"
  | "measure"
  | "when"
  | "person"
  | "specialist"
  | "code"
  | "state"
  | "delegation"
  | "sources"
  | "link"
  | "proposal"
  | "not_known"
  | "id"
  /** A control's words written by the read model (a label that names a person or a version). */
  | "label";
/** The shape of the rows of a bound collection; `row` is a plain row whose fields a component maps. */
export type RowKind =
  "row" | "receipt" | "decision" | "approval" | "fact" | "finding" | "day" | "resource";
export type LinkSurface =
  | "now"
  | "decisions"
  | "decision"
  | "receipt"
  | "job_record"
  | "view"
  | "manual"
  | "settings_ai_team";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export const LIMITS = deepFreeze({
  /** UTF-8 bytes of the JSON text. */
  bytes: 65_536,
  /** Nested objects and arrays below the document itself. */
  depth: 6,
  /** Values in the document; a 64 KB JSON text cannot hold more. */
  nodes: 32_768,
  components: 120,
  data: 8,
  actions: 6,
  links: 3,
  /** Citations per data entry and code units per fact_id, as the Worker's run and receipt paths
   * take them (workers-bus/src/agents/run-output.ts and api.ts). */
  sources: 40,
  fact_id: 160,
  /** Code points in one literal. */
  literal: 80,
  /** Density limits, TEMPLATES.md 4.5 (ZL-13). Side and summary sizes are the slot maxima below. */
  charts: 2,
  status_counts: 4,
  identity: 3,
  meta: 3,
  key_values_rows: 8,
  table_columns: 7,
  comparison_criteria: 12,
  chart_series: 3,
  filters: 4,
});

// ---------------------------------------------------------------------------------------------
// Components (TEMPLATES.md section 3). Props are listed in the order the validator reads them: a
// collection comes before the row fields that refer to it.

type Types = readonly ValueType[];

export type PropDef =
  /** Literal words: a label, heading or sentence. */
  | { readonly is: "words"; readonly nullable: boolean }
  /** A binding to one value. */
  | { readonly is: "value"; readonly types: Types; readonly nullable: boolean }
  /** A list of bindings to values. */
  | { readonly is: "values"; readonly types: Types; readonly max: number }
  /** A binding to a collection; `any` takes rows of every kind. */
  | { readonly is: "rows"; readonly rows: RowKind | "any" }
  /** A binding to one row of a collection, by its item number. */
  | { readonly is: "row"; readonly rows: RowKind }
  /** A row field of the collection named by `of` (a prop of this object or its component). */
  | { readonly is: "field"; readonly of: string; readonly types: Types; readonly nullable: boolean }
  | { readonly is: "fields"; readonly of: string; readonly types: Types; readonly max: number }
  | {
      readonly is: "objects";
      readonly props: Readonly<Record<string, PropDef>>;
      readonly min: number;
      readonly max: number;
    }
  | { readonly is: "choice"; readonly values: readonly string[] }
  | { readonly is: "primary" }
  /** An item number into the view's `actions` or `links`, or null. */
  | { readonly is: "index"; readonly into: "actions" | "links" }
  /** A filter value compared with a state field: a lower-case token. */
  | { readonly is: "token" }
  /** Column labels of this table to total, or null. */
  | { readonly is: "totals" };

const SHOWN: Types = [
  "text",
  "money",
  "count",
  "percent",
  "measure",
  "when",
  "person",
  "specialist",
  "code",
  "state",
  "not_known",
];
const NAMES: Types = ["text", "code", "person", "specialist"];
const AMOUNTS: Types = ["money", "count", "percent", "measure"];
const SUMMABLE: Types = ["money", "count", "measure"];
/** `@body`: the filter bar filters the collections bound in the template's body slot. */
const BODY = "@body";

const words = (nullable = false): PropDef => ({ is: "words", nullable });
const value = (types: Types, nullable = false): PropDef => ({ is: "value", types, nullable });
const rows = (kind: RowKind | "any" = "any"): PropDef => ({ is: "rows", rows: kind });
const field = (of: string, types: Types, nullable = false): PropDef => ({
  is: "field",
  of,
  types,
  nullable,
});
const objects = (props: Record<string, PropDef>, min: number, max: number): PropDef => ({
  is: "objects",
  props,
  min,
  max,
});
const primary: PropDef = { is: "primary" };

export const COMPONENTS = deepFreeze({
  record_heading: {
    name: value(NAMES),
    identity: { is: "values", types: NAMES, max: LIMITS.identity },
    kind_words: words(),
  },
  status_line: {
    counts: objects(
      { value: value(["count"]), one: words(), other: words(), zero: words(true) },
      1,
      LIMITS.status_counts,
    ),
  },
  summary_cells: {
    cells: rows(),
    title: field("cells", ["text"]),
    lines: field("cells", ["text"]),
    state: field("cells", ["state"]),
    sources: field("cells", ["sources"]),
  },
  macro_tile: {
    label: words(),
    value: value([...AMOUNTS, "when", "not_known"]),
    line: value(["text"], true),
    source: value(["sources"], true),
  },
  key_values: {
    heading: words(true),
    rows: objects({ label: words(), value: value(SHOWN) }, 1, LIMITS.key_values_rows),
  },
  list: {
    heading: words(true),
    rows: rows(),
    title: field("rows", NAMES),
    meta: { is: "fields", of: "rows", types: SHOWN, max: LIMITS.meta },
    state: field("rows", ["state"], true),
    proposed: field("rows", ["proposal"], true),
    link: field("rows", ["link"], true),
    primary,
  },
  table: {
    heading: words(true),
    rows: rows(),
    columns: objects(
      { label: words(), field: field("rows", [...SHOWN, "sources", "proposal"]) },
      1,
      LIMITS.table_columns,
    ),
    total: { is: "totals" },
  },
  comparison_columns: {
    heading: words(true),
    options: rows(),
    name: field("options", NAMES),
    proposed: field("options", ["proposal"], true),
    criteria: objects(
      { label: words(), field: field("options", SHOWN) },
      1,
      LIMITS.comparison_criteria,
    ),
    versus: field("options", ["money"], true),
  },
  chart: {
    heading: words(),
    // `kind` names the component, so the bar-or-line choice is `chart_kind`.
    chart_kind: { is: "choice", values: ["bar", "line"] },
    series: objects(
      {
        label: words(),
        points: rows(),
        x: field("points", ["when", ...NAMES]),
        y: field("points", AMOUNTS),
      },
      1,
      LIMITS.chart_series,
    ),
  },
  timeline: {
    heading: words(true),
    items: rows(),
    when: field("items", ["when"]),
    actor: field("items", NAMES),
    actor_kind: field("items", ["state"], true),
    what: field("items", ["text"]),
    detail: field("items", ["text"], true),
    link: field("items", ["link"], true),
  },
  schedule: {
    mode: { is: "choice", values: ["grid", "map"] },
    days: rows("day"),
    resources: rows("resource"),
    blocks: rows(),
    resource: field("blocks", ["id"]),
    day: field("blocks", ["when"]),
    start: field("blocks", ["when"]),
    title: field("blocks", NAMES),
    state: field("blocks", ["state"], true),
    proposed: field("blocks", ["proposal"], true),
    link: field("blocks", ["link"], true),
  },
  receipt_rows: { heading: words(true), receipts: rows("receipt") },
  agent_lane: { heading: words(), receipts: rows("receipt"), primary },
  decision_links: { heading: words(true), decisions: rows("decision"), primary },
  fact_rows: { heading: words(), facts: rows("fact"), primary },
  approvals: { heading: words(), approvals: rows("approval") },
  alert: { finding: { is: "row", rows: "finding" }, action: { is: "index", into: "actions" } },
  proposed_value: { proposal: value(["proposal"]) },
  source_chips: { sources: value(["sources"]) },
  text: { words: words() },
  filter_bar: {
    filters: objects(
      { label: words(), field: field(BODY, ["state"]), equals: { is: "token" } },
      1,
      LIMITS.filters,
    ),
  },
  empty_hint: {
    words: words(),
    link: { is: "index", into: "links" },
    action: { is: "index", into: "actions" },
  },
} satisfies Record<ComponentKind, Readonly<Record<string, PropDef>>>);

// ---------------------------------------------------------------------------------------------
// Templates (TEMPLATES.md section 8 slot tables; manual surfaces from 4.7).

export interface SlotRule {
  readonly kinds: readonly ComponentKind[];
  readonly min: number;
  readonly max: number;
}
export interface TemplateDef {
  readonly slots: Readonly<Partial<Record<SlotName, SlotRule>>>;
  /** Ids a `manual` link may name: the screens where a person does the whole view's work. */
  readonly manual: readonly string[];
}

const SLOT_NAMES: readonly SlotName[] = [
  "heading",
  "status",
  "summary",
  "alerts",
  "filters",
  "body",
  "side",
  "empty",
];
const slot = (kinds: readonly ComponentKind[], min: number, max: number): SlotRule => ({
  kinds,
  min,
  max,
});
const HEADING_OPTIONAL = slot(["record_heading"], 0, 1);
const STATUS = slot(["status_line"], 1, 1);
const FILTERS = slot(["filter_bar"], 0, 1);
const EMPTY = slot(["empty_hint"], 1, 1);

export const TEMPLATES = deepFreeze({
  list: {
    slots: {
      heading: HEADING_OPTIONAL,
      status: STATUS,
      summary: slot(["macro_tile"], 0, 4),
      filters: FILTERS,
      body: slot(["list", "decision_links", "receipt_rows", "table"], 1, 2),
      side: slot(["key_values", "text", "alert", "source_chips"], 0, 3),
      empty: EMPTY,
    },
    manual: ["production_plan", "sales_desk", "money_issues", "search"],
  },
  record: {
    slots: {
      heading: slot(["record_heading"], 1, 1),
      status: slot(["status_line"], 0, 1),
      summary: slot(["summary_cells", "macro_tile"], 0, 4),
      alerts: slot(["alert"], 0, 2),
      body: slot(
        ["agent_lane", "fact_rows", "timeline", "table", "proposed_value", "key_values", "text"],
        1,
        6,
      ),
      side: slot(["approvals", "decision_links", "key_values", "list", "fact_rows"], 0, 4),
      empty: EMPTY,
    },
    manual: ["job_record", "property_record_edit"],
  },
  comparison: {
    slots: {
      heading: slot(["record_heading"], 1, 1),
      status: STATUS,
      body: slot(
        ["comparison_columns", "proposed_value", "table", "receipt_rows", "decision_links"],
        1,
        4,
      ),
      side: slot(["key_values", "text", "source_chips"], 0, 3),
      empty: EMPTY,
    },
    manual: ["supplier_table"],
  },
  report: {
    slots: {
      heading: HEADING_OPTIONAL,
      status: STATUS,
      summary: slot(["macro_tile"], 0, 4),
      alerts: slot(["alert"], 0, 3),
      body: slot(["table", "chart", "proposed_value", "receipt_rows"], 1, 5),
      side: slot(["key_values", "text", "source_chips"], 0, 3),
      empty: EMPTY,
    },
    manual: ["cost_table"],
  },
  timeline: {
    slots: {
      heading: HEADING_OPTIONAL,
      status: STATUS,
      filters: FILTERS,
      body: slot(["timeline"], 1, 1),
      side: slot(["decision_links", "key_values", "receipt_rows"], 0, 2),
      empty: EMPTY,
    },
    manual: ["job_history"],
  },
  schedule: {
    slots: {
      heading: HEADING_OPTIONAL,
      status: STATUS,
      filters: FILTERS,
      body: slot(["schedule", "list"], 1, 2),
      side: slot(["decision_links", "key_values", "alert"], 0, 3),
      empty: EMPTY,
    },
    manual: ["production_plan"],
  },
} satisfies Record<TemplateId, TemplateDef>);

// ---------------------------------------------------------------------------------------------
// Places (TEMPLATES.md 4.4) and link surfaces (sections 5.3 and 10).

export interface PlaceRule {
  readonly templates: readonly TemplateId[];
  readonly actions: boolean;
  readonly money: boolean;
  readonly surfaces: readonly LinkSurface[];
  /** Rows only office surfaces show (decisions, approvals, receipts), whichever component binds them. */
  readonly refusedRows: readonly RowKind[];
}

export interface SurfaceRule {
  /** `none`: no id; `required`: a binding to an id field or a literal id; `manual`: an id from the template's list. */
  readonly id: "none" | "required" | "manual";
  /** The words every label of this surface starts with, and the issue when one does not. */
  readonly label: { readonly start: string; readonly code: ViewSpecIssueCode } | null;
}

export const LINK_SURFACES = deepFreeze({
  now: { id: "none", label: null },
  decisions: { id: "none", label: null },
  decision: { id: "required", label: { start: "Review", code: "decision_link_not_review" } },
  // The panel is "What the AI did"; its links name their object (Track B).
  receipt: {
    id: "required",
    label: { start: "See receipt for", code: "receipt_link_not_see_receipt" },
  },
  job_record: { id: "required", label: null },
  view: { id: "required", label: null },
  manual: { id: "manual", label: null },
  settings_ai_team: { id: "none", label: null },
} satisfies Record<LinkSurface, SurfaceRule>);

export const PLACES = deepFreeze({
  office: {
    templates: ["list", "record", "comparison", "report", "timeline", "schedule"],
    actions: true,
    money: true,
    surfaces: [
      "now",
      "decisions",
      "decision",
      "receipt",
      "job_record",
      "view",
      "manual",
      "settings_ai_team",
    ],
    refusedRows: [],
  },
  crew: {
    templates: ["record", "timeline", "schedule"],
    actions: false,
    money: false,
    // The crew's own Now is its Today; receipts and records are office surfaces (TEMPLATES.md 4.4, 8.5).
    surfaces: ["now"],
    refusedRows: ["decision", "approval", "receipt"],
  },
  customer: null,
  glove: null,
} satisfies Record<Place, PlaceRule | null>);

// ---------------------------------------------------------------------------------------------
// Read models. A field path is a JSON pointer into the read model's response, with `*` for each
// item of a collection; a binding may name an item by number (`/items/0`). The GET path template
// names its path params in braces; every other param goes in the query string.

export type ParamDef =
  | {
      readonly kind:
        "id" | "token" | "text" | "boolean" | "duration" | "action_id" | "specialist_id";
      readonly required: boolean;
      readonly in: "path" | "query";
    }
  | {
      readonly kind: "integer";
      readonly required: boolean;
      readonly in: "query";
      readonly min: number;
      readonly max: number;
    };

/** A value type; `{rows}` for a collection; `{link}` for a row link with the surfaces it may open. */
export type FieldDescriptor =
  | Exclude<ValueType, "link">
  | { readonly rows: RowKind }
  | { readonly link: readonly LinkSurface[] };

export interface ReadModelEntry {
  readonly available: boolean;
  /** The GET path template, or null while the Worker serves no such read model. */
  readonly path: string | null;
  readonly params: Readonly<Record<string, ParamDef>>;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  /** TEMPLATES.md needs this entry's route does not serve yet. */
  readonly planned_params: Readonly<Record<string, ParamDef>>;
  readonly planned_fields: Readonly<Record<string, FieldDescriptor>>;
}
export type ReadModelRegistry = Readonly<Record<string, ReadModelEntry>>;

const pathId: ParamDef = { kind: "id", required: true, in: "path" };
const queryParam = (kind: Exclude<ParamDef["kind"], "integer">, required = false): ParamDef => ({
  kind,
  required,
  in: "query",
});
const PAGE_SIZE: ParamDef = { kind: "integer", required: false, in: "query", min: 1, max: 50 };

/** The fields of one collection: `{rows}` at `path`, each named field at `path/*\/name`. */
function collection(
  path: string,
  kind: RowKind,
  fields: Readonly<Record<string, FieldDescriptor>> = {},
): Record<string, FieldDescriptor> {
  const out: Record<string, FieldDescriptor> = { [path]: { rows: kind } };
  for (const [name, descriptor] of Object.entries(fields)) out[`${path}/*/${name}`] = descriptor;
  return out;
}

function entry(
  available: boolean,
  path: string | null,
  params: Record<string, ParamDef>,
  fields: Record<string, FieldDescriptor>,
  planned_params: Record<string, ParamDef> = {},
  planned_fields: Record<string, FieldDescriptor> = {},
): ReadModelEntry {
  return { available, path, params, fields, planned_params, planned_fields };
}

const HISTORY_ITEMS = {
  ...collection("/items", "row", {
    when: "when",
    actor: "text",
    actor_kind: "state",
    what: "text",
    detail: "text",
    receipt_link: { link: ["receipt"] },
  }),
  "/count_shown": "count",
  "/count_total": "count",
  "/count_ai": "count",
  "/count_people": "count",
} satisfies Record<string, FieldDescriptor>;

export const READ_MODELS: ReadModelRegistry = deepFreeze({
  // Served today. Paths and types follow the app's zod contracts and the Worker builders; a value
  // may be null where the route allows it, which means the record has none. Money, quantities and
  // raw enums are not published from these routes: none returns money as one minor-units value
  // with its currency, and an enum has no plain words yet.
  now: entry(
    true,
    "/api/v1/now",
    {},
    {
      "/read_model_generated_at": "when",
      "/ui/title": "text",
      "/ui/explanation": "text",
      "/ui/sync_label": "text",
      ...collection("/ui/sections", "row", { title: "text", summary: "text" }),
      ...collection("/ui/sections/*/cards", "row", {
        eyebrow: "text",
        title: "text",
        detail: "text",
      }),
    },
  ),
  owner_now: entry(
    true,
    "/api/v1/owner/now",
    {},
    {
      "/read_model_generated_at": "when",
      "/source_updated_at": "when",
      "/summary/active_jobs": "count",
      "/summary/field_blockers": "count",
      "/summary/blocked_gates": "count",
      "/summary/open_incidents": "count",
      "/summary/finance_exceptions": "count",
      "/summary/untriaged_leads": "count",
      "/summary/lead_triage_unknown": "count",
      "/summary/mctb_unproven_due": "count",
      "/summary/material_exceptions": "count",
      ...collection("/exceptions", "row", {
        id: "id",
        title: "text",
        why: "text",
        job_id: "id",
        occurred_at: "when",
        due_at: "when",
        received_at: "when",
      }),
    },
    { section: queryParam("token") },
    {
      "/count": "count",
      "/count_work_stopped": "count",
      "/count_needs_viewer": "count",
      ...collection("/items", "row", {
        job_name: "text",
        job_code: "code",
        reason: "text",
        state: "state",
        proposal: "proposal",
        decision_link: { link: ["decision"] },
      }),
      "/sources": "sources",
    },
  ),
  search: entry(
    true,
    "/api/v1/search",
    { q: queryParam("text", true) },
    {
      "/read_model_generated_at": "when",
      "/source_updated_at": "when",
      ...collection("/groups", "row", { label: "text" }),
      ...collection("/groups/*/results", "row", { id: "id", label: "text", detail: "text" }),
    },
  ),
  job_commercial_context: entry(
    true,
    "/api/v1/jobs/{job}/commercial-context",
    { job: pathId },
    {
      "/generated_at": "when",
      "/job/roof_job_id": "id",
      "/job/job_number": "text",
      "/job/customer_display_name": "text",
      "/offer/publication/occurred_at": "when",
      "/offer/acceptance/accepted_at": "when",
    },
    {},
    collection("/rows", "row", {
      label: "text",
      explanation: "text",
      amount: "money",
      sources: "sources",
    }),
  ),
  job_history: entry(
    true,
    "/api/v1/jobs/{job}/history",
    { job: pathId },
    {
      "/read_model_generated_at": "when",
      "/source_updated_at": "when",
      "/job/id": "id",
      "/job/job_number": "text",
      "/job/status": "text",
      "/job/address": "text",
      "/job/current_gate_state": "text",
      "/customer/display_name": "text",
      "/customer/phone": "text",
      ...collection("/gates", "row", {
        name: "text",
        state: "text",
        blocker_reason: "text",
        owner: "text",
        due_at: "when",
      }),
      ...collection("/proof/items", "row", {
        id: "id",
        summary: "text",
        occurred_at: "when",
        source: "text",
        sync_state: "text",
      }),
    },
    { page_size: PAGE_SIZE },
    HISTORY_ITEMS,
  ),
  inventory_overview: entry(
    true,
    "/api/v1/inventory/overview",
    {},
    {
      "/read_model_generated_at": "when",
      "/summary/position_count": "count",
      "/summary/item_count": "count",
      ...collection("/items", "row", { item_id: "id", item_code: "text" }),
      ...collection("/positions", "row", {
        position_id: "id",
        item_code: "text",
        lot_code: "text",
        bin_code: "text",
        location_name: "text",
        updated_at: "when",
      }),
    },
  ),
  job_phase: entry(
    true,
    "/api/v1/jobs/{job}/phase",
    { job: pathId },
    {
      "/read_model_generated_at": "when",
      "/job/roof_job_id": "id",
      "/job/property_id": "id",
      ...collection("/facts/production/gates", "row", {
        gate: "text",
        blocker_reason: "text",
        updated_at: "when",
      }),
      "/facts/production/assignment/scheduled_start": "when",
      "/facts/production/assignment/scheduled_end": "when",
      ...collection("/facts/safety/active_stops", "row", {
        occurrence_id: "id",
        updated_at: "when",
      }),
    },
  ),
  accounting_intent: entry(
    true,
    "/api/v1/accounting/intents/{intent}",
    { intent: pathId },
    {
      "/read_model_generated_at": "when",
      "/intent/intent_id": "id",
      "/intent/roof_job_id": "id",
      "/intent/next_step": "text",
      "/intent/derived_at": "when",
      "/intent/updated_at": "when",
      ...collection("/exceptions", "row", {
        exception_id: "id",
        opened_at: "when",
        updated_at: "when",
      }),
    },
  ),
  // Needed by TEMPLATES.md section 12 and not served yet.
  job_record: entry(
    false,
    null,
    { job: pathId },
    {
      "/address": "text",
      "/job_code": "code",
      "/job_id": "id",
      "/customer_name": "text",
      "/customer_phone": "text",
      "/crew_names": "text",
      "/property_id": "id",
      ...collection("/summary/cells", "row", {
        title: "text",
        lines: "text",
        state: "state",
        sources: "sources",
      }),
      "/purchase_title": "text",
      "/customer_and_address": "text",
      "/state_words": "text",
    },
  ),
  receipts: entry(
    false,
    null,
    { job: queryParam("id"), open_or_since: queryParam("duration") },
    collection("/items", "receipt"),
  ),
  decisions: entry(
    false,
    null,
    {
      job: queryParam("id"),
      action_id: queryParam("action_id"),
      scope: queryParam("token"),
      open: queryParam("boolean"),
    },
    {
      ...collection("/items", "decision", {
        title: "text",
        state: "state",
        delegation: "delegation",
        waiting_on: "text",
        review_label: "text",
        decision_link: { link: ["decision"] },
      }),
      "/count_needs_viewer": "count",
    },
  ),
  approvals: entry(
    false,
    null,
    { job: queryParam("id", true) },
    collection("/items", "approval", {
      thing: "text",
      approved_by: "person",
      when: "when",
      what_they_saw: "text",
      link: { link: ["receipt"] },
    }),
  ),
  property_record: entry(
    false,
    null,
    { property: pathId },
    {
      "/address": "text",
      "/owner_name": "text",
      "/job_count_words": "text",
      "/count_proposed": "count",
      "/count_read_not_checked": "count",
      ...collection("/roof_facts", "fact"),
      ...collection("/warranty_facts", "fact"),
      ...collection("/people", "row", { name: "text", role_words: "text", phone: "text" }),
      ...collection("/jobs", "row", {
        job_code: "code",
        quote_state: "text",
        state: "state",
        proposal: "proposal",
        // The decision when the row needs the viewer, else the record (TEMPLATES.md 5.3).
        next_link: { link: ["decision", "job_record", "view"] },
      }),
      ...collection("/photos_and_notes", "row", { what: "text", when: "when", by: "text" }),
      "/open_quote_job": "id",
    },
  ),
  property_history: entry(false, null, { property: pathId, page_size: PAGE_SIZE }, HISTORY_ITEMS),
  findings: entry(
    false,
    null,
    {
      property: queryParam("id"),
      specialist: queryParam("specialist_id"),
      kind: queryParam("token"),
      open: queryParam("boolean"),
    },
    collection("/items", "finding", {
      proposal: "proposal",
      // The words of a staff.notify follow-up ("Send the task to Tom Lachance"), TEMPLATES.md 12.
      "proposal/notify_label": "label",
    }),
  ),
  supplier_quotes: entry(
    false,
    null,
    { job: queryParam("id", true), item: queryParam("token", true) },
    {
      "/count": "count",
      "/count_proposed": "count",
      ...collection("/options", "row", {
        supplier_name: "text",
        proposed: "proposal",
        product: "text",
        unit_price: "money",
        sheets_price: "money",
        freight: "money",
        landed_cost: "money",
        arrives: "text",
      }),
      "/needed_by": "when",
      "/on_hand": "measure",
      "/shortage_words": "text",
    },
  ),
  margin_watch: entry(
    false,
    null,
    { jobs: queryParam("token") },
    {
      "/count_below_zero": "count",
      "/count_over_estimate": "count",
      "/count_not_known": "count",
      "/count_watched": "count",
      "/over_estimate_total": "money",
      "/over_estimate_jobs_words": "text",
      "/margin_finished": "percent",
      "/margin_finished_planned_words": "text",
      "/margin_in_progress": "percent",
      "/margin_in_progress_reason": "text",
      "/costs_source": "sources",
      "/jobs_source": "sources",
      ...collection("/jobs", "row", {
        job: "text",
        estimated_cost: "money",
        cost_so_far: "money",
        margin: "percent",
        cause: "text",
      }),
      "/method/rule_words": "text",
      "/method/finished_example": "text",
      "/method/planned_example": "text",
    },
  ),
  crew_schedule: entry(
    false,
    null,
    { from: queryParam("token"), through: queryParam("token") },
    {
      ...collection("/days", "day", { day: "when" }),
      ...collection("/resources", "resource", {
        resource_id: "id",
        name: "text",
        members: "text",
      }),
      ...collection("/blocks", "row", {
        resource_id: "id",
        day: "when",
        start: "when",
        job_name_and_code: "text",
        state: "state",
        proposal: "proposal",
        record_link: { link: ["job_record"] },
      }),
      ...collection("/unscheduled", "row", {
        job_name: "text",
        job_code: "code",
        reason: "text",
        state: "state",
        decision_link: { link: ["decision"] },
        needs_date_job_id: "id",
      }),
      "/count_booked": "count",
      "/count_proposed": "count",
      "/count_cannot_start": "count",
      "/count_unscheduled": "count",
      "/next_free_repair_day": "when",
    },
  ),
});

// ---------------------------------------------------------------------------------------------
// Catalog: the structural part of the AI team contract a view needs.

export type Autonomy = "A0" | "A1" | "A2" | "A3" | "H";
export type SideEffectClass =
  | "none"
  | "internal_reversible"
  | "external_reversible"
  | "external_irreversible"
  | "money"
  | "legal"
  | "safety";

export interface ViewSpecCatalogAction {
  readonly action_id: string;
  readonly owners: readonly string[];
  readonly autonomy: Autonomy;
  readonly human_only: boolean;
  readonly delegable: boolean;
  readonly protective: boolean;
  readonly default_delegation: "asks_first" | "within_limits" | "off_until_enabled" | null;
  readonly side_effect_class: SideEffectClass;
  /** The canonical object the action's transition acts on. */
  readonly aggregate: string;
}
export interface ViewSpecCatalogSpecialist {
  readonly specialist_id: string;
  readonly display_name: string;
}
export interface ViewSpecCatalog {
  /** The catalog's SHA-256 as 64 lower-case hex characters (`CATALOG_SHA256`). */
  readonly sha256: string;
  readonly actions: readonly ViewSpecCatalogAction[];
  readonly specialists: readonly ViewSpecCatalogSpecialist[];
}

const AUTONOMY: readonly string[] = ["A0", "A1", "A2", "A3", "H"];
const SIDE_EFFECTS: readonly string[] = [
  "none",
  "internal_reversible",
  "external_reversible",
  "external_irreversible",
  "money",
  "legal",
  "safety",
];
/** The launch rule (TEMPLATES.md 5.2): these effects reach outside the company. */
const OUTSIDE_EFFECTS: readonly string[] = [
  "money",
  "legal",
  "safety",
  "external_irreversible",
  "external_reversible",
];
const DELEGATIONS: readonly unknown[] = ["asks_first", "within_limits", "off_until_enabled", null];
/**
 * The AI team's own controls: delegation, policy, a specialist's hold and staff access. They change
 * only in Settings › AI team (contract delegation rule 3), so no view offers them (TEMPLATES.md 9).
 */
const OWNER_CONTROLS: readonly string[] = [
  "delegation",
  "policy",
  "specialist_hold",
  "user_access",
];
/**
 * Steps a specialist's own run takes and a view shows only as their receipt (orchestrator ruling):
 * the escalation that names a person and the owner's immediate interrupt. No view offers them.
 */
const RUN_ONLY_ACTIONS: readonly string[] = ["exception.escalate", "owner.interrupt"];

/** Builds the catalog from the contract's machine-readable JSON and its SHA-256. Throws on a malformed catalog. */
export function catalogFromContractJson(json: string, sha256: string): ViewSpecCatalog {
  if (!SHA256_HEX.test(sha256)) throw new TypeError("catalog sha256 must be 64 hex digits");
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !Array.isArray(parsed.actions) || !Array.isArray(parsed.specialists)) {
    throw new TypeError("not an AI team contract catalog");
  }
  const actions = parsed.actions.map((raw: unknown, index: number): ViewSpecCatalogAction => {
    if (!isCatalogAction(raw)) throw new TypeError(`catalog action ${index} is malformed`);
    return {
      action_id: raw.action_id,
      owners: [...raw.owners],
      autonomy: raw.autonomy,
      human_only: raw.human_only,
      delegable: raw.delegable,
      protective: raw.protective,
      default_delegation: raw.default_delegation,
      side_effect_class: raw.side_effect_class,
      aggregate: raw.aggregate,
    };
  });
  const specialists = parsed.specialists.map(
    (raw: unknown, index: number): ViewSpecCatalogSpecialist => {
      if (!isCatalogSpecialist(raw))
        throw new TypeError(`catalog specialist ${index} is malformed`);
      return { specialist_id: raw.specialist_id, display_name: raw.display_name };
    },
  );
  return deepFreeze({ sha256, actions, specialists });
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isCatalogAction(raw: unknown): raw is ViewSpecCatalogAction {
  return (
    isRecord(raw) &&
    typeof raw.action_id === "string" &&
    Array.isArray(raw.owners) &&
    raw.owners.every((owner: unknown) => typeof owner === "string") &&
    AUTONOMY.includes(raw.autonomy as string) &&
    typeof raw.human_only === "boolean" &&
    typeof raw.delegable === "boolean" &&
    typeof raw.protective === "boolean" &&
    DELEGATIONS.includes(raw.default_delegation) &&
    SIDE_EFFECTS.includes(raw.side_effect_class as string) &&
    typeof raw.aggregate === "string"
  );
}

function isCatalogSpecialist(raw: unknown): raw is ViewSpecCatalogSpecialist {
  return (
    isRecord(raw) && typeof raw.specialist_id === "string" && typeof raw.display_name === "string"
  );
}

export type ActionRequestKind = "act" | "prepare_for_approval";

/**
 * How a view may offer a catalog action, or null when it may not offer it at all: never a people
 * only act, a read (A0), an action nobody owns or one of the AI team's own controls; `A3` only as
 * a request that creates a proposal on Decisions; `A1` and `A2` act, unless their effect reaches
 * outside the company (launch rule).
 */
export function actionRequestKind(action: ViewSpecCatalogAction): ActionRequestKind | null {
  if (action.owners.length === 0 || action.human_only || action.autonomy === "H") return null;
  if (action.autonomy === "A0" || OWNER_CONTROLS.includes(action.aggregate)) return null;
  if (RUN_ONLY_ACTIONS.includes(action.action_id)) return null;
  if (action.autonomy === "A3") return "prepare_for_approval";
  return OUTSIDE_EFFECTS.includes(action.side_effect_class) ? null : "act";
}

// ---------------------------------------------------------------------------------------------
// The document.

export interface ViewSpecBinding {
  readonly bind: string;
  readonly path: string;
}
export interface ViewSpecField {
  readonly field: string;
}
export interface ViewSpecSource {
  readonly fact_id: string;
  readonly version: number;
  readonly hash: string;
}
export interface ViewSpecData {
  readonly id: string;
  readonly read_model: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
  readonly sources: readonly ViewSpecSource[];
}
export interface ViewSpecComponent {
  readonly kind: ComponentKind;
  /** The kind's props, as COMPONENTS defines them; read them by kind. */
  readonly [prop: string]: unknown;
}
export interface ViewSpecAction {
  readonly action_id: string;
  /** Literal words, or a binding to words the read model writes for this control. */
  readonly label: string | ViewSpecBinding;
  readonly target: ViewSpecBinding | null;
  readonly primary: boolean;
}
export interface ViewSpecLink {
  readonly surface: LinkSurface;
  readonly id: ViewSpecBinding | string | null;
  readonly label: string;
  readonly primary: boolean;
}
export interface ViewSpec {
  readonly schema: typeof VIEW_SPEC_SCHEMA_ID;
  readonly spec_id: string;
  readonly run_id: string;
  readonly specialist_id: "orchestrator";
  readonly catalog_sha256: string;
  readonly template: TemplateId;
  readonly title: string;
  readonly data: readonly ViewSpecData[];
  /** A slot the template does not use is absent, or null in the wire form. */
  readonly slots: Readonly<Partial<Record<SlotName, readonly ViewSpecComponent[] | null>>>;
  readonly actions: readonly ViewSpecAction[];
  readonly links: readonly ViewSpecLink[];
}

export const VIEW_SPEC_ISSUE_CODES = deepFreeze([
  "not_json",
  "too_large",
  "too_deep",
  "wrong_type",
  "unknown_key",
  "missing_key",
  "unknown_schema",
  "bad_id",
  "duplicate_data_id",
  "limit_exceeded",
  "unknown_template",
  "unknown_slot",
  "slot_count",
  "unknown_component",
  "component_not_allowed_in_slot",
  "literal_empty",
  "literal_too_long",
  "literal_has_digits",
  "literal_has_number_words",
  "literal_has_currency",
  "literal_has_url",
  "literal_has_markup",
  "literal_bad_character",
  "literal_banned_term",
  "literal_delegation_words",
  "control_label_not_verb_object",
  "control_label_decision_verb",
  "decision_link_not_review",
  "receipt_link_not_see_receipt",
  "unknown_read_model",
  "read_model_unavailable",
  "bad_params",
  "unbound_binding",
  "bad_path",
  "unknown_field_path",
  "field_type_mismatch",
  "missing_sources",
  "bad_source",
  "unknown_specialist",
  "specialist_not_face",
  "catalog_mismatch",
  "unknown_action",
  "action_not_owned",
  "action_people_only",
  "action_read_only",
  "action_outside_effect",
  "action_owner_control",
  "action_run_only",
  "action_asks_first_not_offered_as_request",
  "action_label_promises_approval",
  "action_target_unbound",
  "unknown_surface",
  "bad_link_id",
  "bad_index",
  "two_next_steps",
  "primary_count",
  "chart_without_table",
  "total_not_a_column",
  "versus_not_a_criterion",
  "place_not_allowed",
  "validator_failed",
] as const);
export type ViewSpecIssueCode = (typeof VIEW_SPEC_ISSUE_CODES)[number];

export interface ViewSpecIssue {
  readonly code: ViewSpecIssueCode;
  /** JSON pointer to the offending value ("" is the whole document). */
  readonly path: string;
  /** One sentence for System details and the run record; never shown on the page. */
  readonly detail: string;
}
export type ViewSpecResult =
  | { readonly ok: true; readonly spec: ViewSpec }
  | { readonly ok: false; readonly issues: readonly ViewSpecIssue[] };

export interface ViewSpecOptions {
  readonly place: Place;
  /** Tests may pass a registry with more read models available; production uses READ_MODELS. */
  readonly readModels?: ReadModelRegistry;
}

/** The renderer's words when a spec is invalid and the answer carries no plain cited text. */
export const viewSpecFallbackWords = deepFreeze({
  title: "IronWrap couldn't show this.",
  next_step: "Ask another way, or search.",
});

// ---------------------------------------------------------------------------------------------
// Patterns and word rules.

const SPEC_ID = /^vs_[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^run_[A-Za-z0-9_-]{1,64}$/;
const DATA_ID = /^[a-z][a-z0-9_]{0,31}$/;
const POINTER = /^(?:\/(?:[A-Za-z_][A-Za-z0-9_]{0,63}|0|[1-9][0-9]{0,3}|\*)){1,8}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/;
const ACTION_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** A free-text param, such as a search query; GET /api/v1/search refuses more UTF-16 units. */
const TEXT_PARAM = 120;
const HASH = /^sha256:[0-9a-f]{64}$/;
const DURATION = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
/** `<object>/<id>`, `evidence/<id>` or `<provider>/<entity>/<id>`, optionally `#` and a JSON pointer. */
const FACT_ID =
  /^[a-z][a-z0-9_]*\/[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?(?:#(?:\/[A-Za-z0-9_.~-]*)+)?$/;

const DIGITS = /[\p{Nd}\p{Nl}\p{No}]/u;
const CURRENCY = /\p{Sc}/u;
const URL_LIKE =
  /\b[a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|vbscript|data|mailto|tel|sms|file):|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
const MARKUP = /[<>]/;
/**
 * The characters literal words may use: letters of ASCII, Latin-1 Supplement and Latin
 * Extended-A, the space and plain punctuation. Digits, currency signs and markup have codes of
 * their own; everything else (control, format and invisible characters, IPA and small capitals,
 * other scripts, emoji) is refused. Accents, and the few letters of those blocks that read as
 * others, are folded away (`fold`) before the word rules read a literal.
 */
const LITERAL_CHARACTER = /[A-Za-zÀ-ÖØ-öø-ſ .,;:!?'’"“”()–—/&·-]/u;
/** Letters of those blocks that pass for others and fold to nothing plain: thorn and eng. */
const LOOKALIKE_LETTER = /[ÞþŊŋ]/u;
/** Letters of Latin-1 and Latin Extended-A that no decomposition reduces to a plain letter. */
const FOLD: Readonly<Record<string, string>> = {
  ı: "i",
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  ħ: "h",
  Ħ: "H",
  ŧ: "t",
  Ŧ: "T",
  ĸ: "k",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ß: "ss",
  þ: "th",
  Þ: "Th",
};
/**
 * Numbers and money in words are facts too: two to twenty, the tens, the large numbers, money.
 * "one" and "zero" stay plain words ("no one", "each one", "below zero margin"); a count still has
 * to be bound, and the status line's zero words are the renderer's for a bound zero.
 */
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|half|halves|percent|dollars?|cents?|CAD|USD)\b/i;

/**
 * Z2 of design/ZERO-LEARNING-GATE.md and ZL-1 of TEMPLATES.md. The first block mirrors `BANNED` in
 * app/scripts/plain-language.family.test.ts term for term, and a guard test runs that file's own
 * examples against this list; the rest are the names a view may not give the AI team, and its
 * class codes.
 */
const BANNED_TERMS: readonly (readonly [string, RegExp])[] = [
  ["work package", /\bwork[ -]?packages?\b/i],
  ["disposition", /\bdispositions?\b/i],
  ["derived phase", /\bderived phases?\b/i],
  ["outbox", /\boutbox(?:es)?\b/i],
  ["idempotency", /\bidempoten\w*/i],
  ["effect", /\beffects?\b/i],
  ["capability", /\bcapabilit(?:y|ies)\b/i],
  ["principal", /\bprincipals?\b/i],
  ["receipt hash", /\breceipt hash(?:es)?\b/i],
  ["digest", /\bdigests?\b/i],
  ["SHA", /\bSHA(?:-?\d+)?\b/],
  ["envelope", /\benvelopes?\b/i],
  ["payload", /\bpayloads?\b/i],
  ["tenant", /\btenants?\b/i],
  ["grant", /\bgrants?\b/i],
  ["qualifying", /\bqualifying\b/i],
  ["snapshot", /\bsnapshots?\b/i],
  ["observed", /\bobserved\b/i],
  ["projection", /\bprojections?\b/i],
  ["read-back", /\bread[- ]?backs?\b/i],
  ["read model", /\bread models?\b/i],
  ["source coverage", /\bsource coverage\b/i],
  ["source sum", /\bsource sums?\b/i],
  ["OIDC", /\bOIDC\b/],
  ["OAuth", /\bOAuth\b/i],
  ["JSON", /\bJSON\b/],
  ["MCP", /\bMCP\b/],
  ["R2", /\bR2\b/],
  ["D1", /\bD1\b/],
  ["CSRF", /\bCSRF\b/],
  ["Worker", /\bWorker\b/],
  ["BFF", /\bBFF\b/],
  ["version label", /\bv(?:\d+|\{x\})(?![\w{])|\bversion (?:\d|\{x\})/i],
  ["Assistant", /\bassistants?\b/i],
  ["agent", /\bagents?\b/i],
  ["HELM", /\bHELM\b/],
  ["Hermes", /\bHermes\b/],
  ["Newo", /\bNewo\b/],
  ["Postiz", /\bPostiz\b/],
  ["model name", /\b(?:bots?|chatbots?|Claude|Codex|GPT|ChatGPT|LLMs?)\b/i],
  ["class code", /\b(?:A[0-3]|H)\b/],
  ["AI spelled out", /\bA\s*\.\s*I\b|\bA\s+I\b/],
];
/** The renderer derives delegation words from the contract and the setting; a spec never states them. */
const DELEGATION_WORDS =
  /\b(?:reads and watches|acts within your limits|always asks first|asks first|off until you turn it on|people only|always on: protects you|paused here)\b/i;
/** ZL-4: a control label is a verb and its object, and never one of these. */
const BANNED_START = /^(?:open|go|submit|ok|okay)\b/i;
/**
 * 5.3: a decision happens on its fixed surface, so no control in a view names a decision's verb,
 * in any form and anywhere in its label.
 */
const DECISION_VERB_FORMS =
  "(?:pre|re|dis|co|counter)?(?:approv(?:e|es|ed|ing)|authori[sz](?:e|es|ed|ing)|confirm(?:s|ed|ing)?|sign(?:s|ed|ing)?|pa(?:y|ys|id|ying))|declin(?:e|es|ed|ing)|accept(?:s|ed|ing)?|reject(?:s|ed|ing)?|releas(?:e|es|ed|ing)|waiv(?:e|es|ed|ing)|refund(?:s|ed|ing)?|appl(?:y|ies|ied|ying)|(?:write|writes|wrote|written|writing) off";
const DECISION_VERB = new RegExp(`\\b(?:${DECISION_VERB_FORMS})\\b`, "i");
/**
 * A label in one of the fixed frames ("Prepare … for your approval", "Review …", "See receipt for
 * …") has its verb already; the rest names the object, which may be a release or a refund. Only a
 * second verb joined to the frame ("Review and approve") is refused there.
 */
const FRAMED_LABEL = /^(?:Prepare|Review|See receipt for)\s/;
const FRAMED_DECISION_VERB = new RegExp(
  `\\b(?:and|then|to|or|&)\\s+(?:${DECISION_VERB_FORMS})\\b`,
  "i",
);
const REQUEST_LABEL = /^Prepare \S.* for your approval$/;
const PROMISES_APPROVAL = /\bfor your approval\b/i;

// ---------------------------------------------------------------------------------------------
// JSON Schema export in the strict dialect of workers-bus/src/agents/schema.ts: no unions, every
// object closed and every property required, optional values as a null type member. The gateway
// hands it to the model as the output schema; `validateViewSpec` then runs the semantic rules.

export type JsonSchema = { readonly [keyword: string]: unknown };

export interface ViewSpecJsonSchemaOptions {
  /** With a catalog, `catalog_sha256` is pinned and `action_id` lists only the actions a view may offer. */
  readonly catalog?: ViewSpecCatalog;
  readonly readModels?: ReadModelRegistry;
}

export function viewSpecJsonSchema(options: ViewSpecJsonSchemaOptions = {}): JsonSchema {
  const served = Object.entries(options.readModels ?? READ_MODELS).filter(
    ([, model]) => model.available,
  );
  const catalog = options.catalog;
  const offered = catalog?.actions
    .filter((action) => actionRequestKind(action) !== null)
    .map((action) => action.action_id);
  const slotSchemas: Record<string, JsonSchema> = {};
  for (const name of SLOT_NAMES) {
    const kinds = new Set<ComponentKind>();
    let max = 0;
    for (const def of Object.values(TEMPLATES) as TemplateDef[]) {
      const rule = def.slots[name];
      if (!rule) continue;
      for (const kind of rule.kinds) kinds.add(kind);
      max = Math.max(max, rule.max);
    }
    slotSchemas[name] = {
      type: ["array", "null"],
      maxItems: max,
      items: componentShape([...kinds]),
    };
  }
  return {
    ...closed({
      schema: { type: "string", const: VIEW_SPEC_SCHEMA_ID },
      spec_id: { type: "string", pattern: SPEC_ID.source },
      run_id: { type: "string", pattern: RUN_ID.source },
      specialist_id: { type: "string", enum: ["orchestrator"] },
      catalog_sha256: catalog
        ? { type: "string", const: `sha256:${catalog.sha256}` }
        : { type: "string", pattern: HASH.source },
      template: { type: "string", enum: Object.keys(TEMPLATES) },
      title: WORDS_SCHEMA,
      data: {
        type: "array",
        minItems: 1,
        maxItems: LIMITS.data,
        items: closed({
          id: { type: "string", pattern: DATA_ID.source },
          read_model: { type: "string", enum: served.map(([name]) => name) },
          params: paramsShape(served.map(([, model]) => model)),
          sources: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.sources,
            items: closed({
              fact_id: { type: "string", maxLength: LIMITS.fact_id, pattern: FACT_ID.source },
              version: { type: "integer", minimum: 0 },
              hash: { type: "string", pattern: HASH.source },
            }),
          },
        }),
      },
      slots: closed(slotSchemas),
      actions: {
        type: "array",
        maxItems: LIMITS.actions,
        items: closed({
          action_id: offered
            ? { type: "string", enum: offered }
            : { type: "string", pattern: ACTION_ID.source },
          label: { ...BINDING_SCHEMA, ...WORDS_SCHEMA, type: ["object", "string"] },
          target: nullable(BINDING_SCHEMA),
          primary: { type: "boolean" },
        }),
      },
      links: {
        type: "array",
        maxItems: LIMITS.links,
        items: closed({
          surface: { type: "string", enum: Object.keys(LINK_SURFACES) },
          id: {
            ...BINDING_SCHEMA,
            type: ["object", "string", "null"],
            maxLength: 160,
            pattern: ID_VALUE.source,
          },
          label: WORDS_SCHEMA,
          primary: { type: "boolean" },
        }),
      },
    }),
    description:
      "An IronWrap generated view. Facts come only from bindings into the declared data; literal words are labels without digits. Set props, slots and params that do not apply to null.",
  };
}

const WORDS_SCHEMA: JsonSchema = { type: "string", minLength: 1, maxLength: LIMITS.literal };
const BINDING_SCHEMA: JsonSchema = closed({
  bind: { type: "string", pattern: DATA_ID.source },
  path: { type: "string", maxLength: 256, pattern: POINTER.source },
});
const FIELD_SCHEMA: JsonSchema = closed({ field: { type: "string", pattern: FIELD_NAME.source } });

function closed(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

function nullable(schema: JsonSchema): JsonSchema {
  const types = typeList(schema.type);
  const out: Record<string, unknown> = { ...schema, type: [...new Set([...types, "null"])] };
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
  if (schema.const !== undefined) {
    delete out.const;
    out.enum = [schema.const, null];
  }
  return out;
}

/** One object for every kind a slot accepts: `kind`, then each prop, null for kinds without it. */
function componentShape(kinds: readonly ComponentKind[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    kind:
      kinds.length === 1 ? { type: "string", const: kinds[0] } : { type: "string", enum: kinds },
  };
  const propsOf = (kind: ComponentKind): Readonly<Record<string, PropDef>> => COMPONENTS[kind];
  for (const name of new Set(kinds.flatMap((kind) => Object.keys(propsOf(kind))))) {
    const owners = kinds.filter((kind) => Object.hasOwn(propsOf(kind), name));
    const merged = owners
      .map((kind) => propSchema(propsOf(kind)[name] as PropDef))
      .reduce((a, b) => merge(a, b, name));
    properties[name] = owners.length < kinds.length ? nullable(merged) : merged;
  }
  return closed(properties);
}

function propSchema(def: PropDef): JsonSchema {
  switch (def.is) {
    case "words":
      return def.nullable ? nullable(WORDS_SCHEMA) : WORDS_SCHEMA;
    case "value":
      return def.nullable ? nullable(BINDING_SCHEMA) : BINDING_SCHEMA;
    case "values":
      return { type: "array", maxItems: def.max, items: BINDING_SCHEMA };
    case "rows":
    case "row":
      return BINDING_SCHEMA;
    case "field":
      return def.nullable ? nullable(FIELD_SCHEMA) : FIELD_SCHEMA;
    case "fields":
      return { type: "array", maxItems: def.max, items: FIELD_SCHEMA };
    case "objects":
      return {
        type: "array",
        minItems: def.min,
        maxItems: def.max,
        items: closed(
          Object.fromEntries(
            Object.entries(def.props).map(([name, child]) => [name, propSchema(child)]),
          ),
        ),
      };
    case "choice":
      return { type: "string", enum: def.values };
    case "primary":
      return { type: "boolean" };
    case "index":
      return {
        type: ["integer", "null"],
        minimum: 0,
        maximum: (def.into === "actions" ? LIMITS.actions : LIMITS.links) - 1,
      };
    case "token":
      return { type: "string", pattern: TOKEN.source };
    case "totals":
      return { type: ["array", "null"], maxItems: LIMITS.table_columns, items: WORDS_SCHEMA };
  }
}

/** Unites two prop schemas of one name; they may differ only in their type list (`rows`). */
function merge(a: JsonSchema, b: JsonSchema, name: string): JsonSchema {
  const out: Record<string, unknown> = { ...a };
  for (const [keyword, value] of Object.entries(b)) {
    if (keyword === "type") continue;
    if (Object.hasOwn(a, keyword) && canonical(a[keyword]) !== canonical(value)) {
      throw new Error(`view spec schema: prop ${name} differs in ${keyword} between kinds`);
    }
    out[keyword] = value;
  }
  out.type = [...new Set([...typeList(a.type), ...typeList(b.type)])];
  return out;
}

function paramsShape(models: readonly ReadModelEntry[]): JsonSchema {
  const byName = new Map<string, JsonSchema[]>();
  for (const model of models) {
    for (const [name, def] of Object.entries(model.params)) {
      byName.set(name, [...(byName.get(name) ?? []), paramSchema(def)]);
    }
  }
  const properties: Record<string, JsonSchema> = {};
  for (const [name, schemas] of byName) {
    const first = schemas[0] as JsonSchema;
    const same = schemas.every((schema) => canonical(schema) === canonical(first));
    properties[name] = nullable(
      same ? first : { type: [...new Set(schemas.flatMap((schema) => typeList(schema.type)))] },
    );
  }
  return closed(properties);
}

function paramSchema(def: ParamDef): JsonSchema {
  switch (def.kind) {
    case "id":
      return { type: "string", pattern: ID_VALUE.source };
    case "token":
    case "specialist_id":
      return { type: "string", pattern: TOKEN.source };
    case "action_id":
      return { type: "string", pattern: ACTION_ID.source };
    case "text":
      return { type: "string", minLength: 1, maxLength: TEXT_PARAM };
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer", minimum: def.min, maximum: def.max };
    case "duration":
      return { type: "string", maxLength: 32, pattern: DURATION.source };
  }
}

function typeList(type: unknown): string[] {
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? type.filter((item): item is string => typeof item === "string") : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------------------------
// Validation.

interface CatalogIndex {
  /** False when the caller's catalog is not in the contract's shape: every spec is then refused. */
  readonly valid: boolean;
  readonly sha256: string | null;
  readonly actions: ReadonlyMap<string, ViewSpecCatalogAction>;
  readonly specialists: ReadonlySet<string>;
  /** "AI team" and every display name that starts with "AI", longest first. */
  readonly aiNames: readonly string[];
}

interface Collection {
  readonly dataId: string;
  readonly entry: ReadModelEntry;
  readonly pattern: string;
  readonly exact: string;
}

type Resolved =
  | { readonly is: "value"; readonly type: ValueType; readonly surfaces: readonly LinkSurface[] }
  | { readonly is: "rows"; readonly kind: RowKind; readonly collection: Collection }
  | { readonly is: "row"; readonly kind: RowKind };

interface Scope {
  readonly parent: Scope | null;
  readonly collections: Map<string, Collection | null>;
}

interface Ctx {
  readonly issues: ViewSpecIssue[];
  readonly catalog: CatalogIndex;
  readonly place: PlaceRule | null;
  readonly readModels: ReadModelRegistry;
  /** Declared data ids; null when the entry's read model is unknown. */
  readonly data: Map<string, ReadModelEntry | null>;
  /** Data ids already reported as `read_model_unavailable`. */
  readonly unavailable: Set<string>;
  template: TemplateDef | null;
  templateId: TemplateId | null;
  actionCount: number;
  linkCount: number;
  components: number;
  readonly primaries: string[];
  /** Resolved row fields by the JSON pointer of their `{field}` object. */
  readonly fieldTypes: Map<string, Resolved>;
  readonly tables: { readonly collection: string; readonly fields: ReadonlySet<string> }[];
  readonly series: {
    readonly path: string;
    readonly collection: string;
    readonly x: string;
    readonly y: string;
  }[];
  readonly bodyCollections: Collection[];
  readonly filterFields: { readonly name: string; readonly path: string }[];
  charts: number;
  bodyTables: number;
}

const TOP_KEYS = [
  "schema",
  "spec_id",
  "run_id",
  "specialist_id",
  "catalog_sha256",
  "template",
  "title",
  "data",
  "slots",
  "actions",
  "links",
];
const DATA_KEYS = ["id", "read_model", "params", "sources"];
const SOURCE_KEYS = ["fact_id", "version", "hash"];
const ACTION_KEYS = ["action_id", "label", "target", "primary"];
const LINK_KEYS = ["surface", "id", "label", "primary"];
const BINDING_KEYS = ["bind", "path"];
const FIELD_KEYS = ["field"];
const ALL_PROPS: ReadonlySet<string> = new Set(
  Object.values(COMPONENTS).flatMap((props) => Object.keys(props)),
);

/**
 * Validates a view spec: a JSON string, or a value parsed from JSON. Returns every issue found, so
 * one answer can name all of them. A spec too large, too deep or not JSON is refused before the
 * rest is read, with that one issue.
 */
export function validateViewSpec(
  input: unknown,
  catalog: ViewSpecCatalog,
  options: ViewSpecOptions,
): ViewSpecResult {
  const refused = (shape: Exclude<Shape, "ok">): ViewSpecResult => ({
    ok: false,
    issues: [{ code: shape, path: "", detail: SHAPE_DETAIL[shape] }],
  });
  let text = input;
  if (typeof input !== "string") {
    // A caller's value may be a host object: walk it without running its code, then validate a
    // copy parsed from its JSON text, so nothing it does later changes what was checked.
    try {
      const shape = measure(input);
      if (shape !== "ok") return refused(shape);
      text = JSON.stringify(input);
    } catch {
      return refused("not_json");
    }
  }
  if (utf8Length(text as string) > LIMITS.bytes) return refused("too_large");
  let value: unknown;
  try {
    value = JSON.parse(text as string);
  } catch {
    return refused("not_json");
  }
  const shape = measure(value);
  if (shape !== "ok") return refused(shape);

  try {
    return checked(value, catalog, options);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "validator_failed",
          path: "",
          detail: "the validator could not read its catalog or read models; nothing was accepted",
        },
      ],
    };
  }
}

function checked(value: unknown, catalog: unknown, options: ViewSpecOptions): ViewSpecResult {
  const place = Object.hasOwn(PLACES, String(options?.place))
    ? PLACES[options.place as Place]
    : null;
  const ctx: Ctx = {
    issues: [],
    catalog: indexCatalog(catalog),
    place,
    readModels: options?.readModels ?? READ_MODELS,
    data: new Map(),
    unavailable: new Set(),
    template: null,
    templateId: null,
    actionCount: 0,
    linkCount: 0,
    components: 0,
    primaries: [],
    fieldTypes: new Map(),
    tables: [],
    series: [],
    bodyCollections: [],
    filterFields: [],
    charts: 0,
    bodyTables: 0,
  };
  if (!place) {
    issue(ctx, "place_not_allowed", "", `no generated view is drawn in ${placeName(options)}`);
  }
  if (!isRecord(value)) {
    issue(ctx, "wrong_type", "", "a view spec is a JSON object");
    return { ok: false, issues: ctx.issues };
  }
  document(ctx, value);
  return ctx.issues.length > 0
    ? { ok: false, issues: ctx.issues }
    : { ok: true, spec: deepFreeze(value) as unknown as ViewSpec };
}

type Shape = "ok" | "not_json" | "too_deep" | "too_large";
const SHAPE_DETAIL: Readonly<Record<Exclude<Shape, "ok">, string>> = {
  not_json: "the spec is not a JSON document of well-formed text",
  too_deep: `objects and arrays nest at most ${LIMITS.depth} deep`,
  too_large: `a view spec is at most ${LIMITS.bytes} bytes`,
};

function document(ctx: Ctx, spec: Record<string, unknown>): void {
  keys(ctx, spec, "", TOP_KEYS);
  if (Object.hasOwn(spec, "schema") && spec.schema !== VIEW_SPEC_SCHEMA_ID) {
    issue(ctx, "unknown_schema", "/schema", `schema must be ${VIEW_SPEC_SCHEMA_ID}`);
  }
  pattern(ctx, spec, "spec_id", "", SPEC_ID, "spec_id is vs_ and letters, digits, _ or -");
  pattern(ctx, spec, "run_id", "", RUN_ID, "run_id is run_ and letters, digits, _ or -");
  specialist(ctx, get(spec, "specialist_id"));
  if (!ctx.catalog.valid) {
    issue(
      ctx,
      "catalog_mismatch",
      "/catalog_sha256",
      "the validator was given a malformed catalog",
    );
  } else if (
    Object.hasOwn(spec, "catalog_sha256") &&
    spec.catalog_sha256 !== `sha256:${ctx.catalog.sha256}`
  ) {
    issue(ctx, "catalog_mismatch", "/catalog_sha256", "catalog_sha256 is not the catalog in force");
  }
  template(ctx, get(spec, "template"));
  if (Object.hasOwn(spec, "title")) literal(ctx, spec.title, "/title");
  if (Object.hasOwn(spec, "data")) data(ctx, spec.data);
  // Actions and links come before slots, which point into them by item number.
  if (Object.hasOwn(spec, "actions")) actions(ctx, spec.actions);
  if (Object.hasOwn(spec, "links")) links(ctx, spec.links);
  if (Object.hasOwn(spec, "slots")) slots(ctx, spec.slots);
  crossChecks(ctx);
}

function specialist(ctx: Ctx, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    issue(ctx, "wrong_type", "/specialist_id", "specialist_id is a string");
    return;
  }
  if (value !== "orchestrator") {
    issue(ctx, "specialist_not_face", "/specialist_id", "only the face (orchestrator) emits views");
  }
  if (!ctx.catalog.specialists.has(value)) {
    issue(ctx, "unknown_specialist", "/specialist_id", "specialist_id is not in the catalog");
  }
}

function template(ctx: Ctx, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !Object.hasOwn(TEMPLATES, value)) {
    issue(ctx, "unknown_template", "/template", "template is not one of the six templates");
    return;
  }
  ctx.templateId = value as TemplateId;
  ctx.template = TEMPLATES[value as TemplateId];
  if (ctx.place && !ctx.place.templates.includes(ctx.templateId)) {
    issue(ctx, "place_not_allowed", "/template", `the ${value} template is not drawn here`);
  }
}

// --- data entries ----------------------------------------------------------------------------

function data(ctx: Ctx, value: unknown): void {
  if (!Array.isArray(value)) {
    issue(ctx, "wrong_type", "/data", "data is an array");
    return;
  }
  if (value.length > LIMITS.data) {
    issue(ctx, "limit_exceeded", "/data", `a view has at most ${LIMITS.data} data entries`);
  }
  value.slice(0, LIMITS.data).forEach((raw, index) => dataEntry(ctx, raw, `/data/${index}`));
}

function dataEntry(ctx: Ctx, raw: unknown, path: string): void {
  if (!isRecord(raw)) {
    issue(ctx, "wrong_type", path, "a data entry is an object");
    return;
  }
  keys(ctx, raw, path, DATA_KEYS);
  const id = get(raw, "id");
  let entryId: string | null = null;
  if (typeof id !== "string" || !DATA_ID.test(id)) {
    issue(ctx, "bad_id", `${path}/id`, "a data id is lower-case letters, digits and _");
  } else if (ctx.data.has(id)) {
    issue(ctx, "duplicate_data_id", `${path}/id`, `data id ${id} is declared twice`);
  } else {
    entryId = id;
  }
  const name = get(raw, "read_model");
  let model: ReadModelEntry | null = null;
  const known = typeof name === "string" && Object.hasOwn(ctx.readModels, name);
  if (!known || !isReadModelEntry(ctx.readModels[name])) {
    issue(ctx, "unknown_read_model", `${path}/read_model`, "read_model is not in the registry");
  } else {
    model = ctx.readModels[name] ?? null;
    if (model && !model.available) {
      issue(ctx, "read_model_unavailable", `${path}/read_model`, `${name} is not served yet`);
      if (entryId) ctx.unavailable.add(entryId);
    }
  }
  if (entryId) ctx.data.set(entryId, model);
  if (Object.hasOwn(raw, "params")) params(ctx, raw.params, `${path}/params`, model, entryId);
  if (Object.hasOwn(raw, "sources")) sources(ctx, raw.sources, `${path}/sources`);
}

function params(
  ctx: Ctx,
  value: unknown,
  path: string,
  model: ReadModelEntry | null,
  dataId: string | null,
): void {
  if (!isRecord(value)) {
    issue(ctx, "wrong_type", path, "params is an object");
    return;
  }
  if (!model) return;
  const fillers = paramNames(ctx.readModels);
  for (const key of Object.keys(value)) {
    const item = value[key];
    const served = own(model.params, key);
    const planned = own(model.planned_params, key);
    const def = served ?? planned;
    if (!def) {
      if (item === null && fillers.has(key)) continue;
      issue(ctx, "bad_params", ptr(path, key), `this read model takes no ${quote(key)} param`);
      continue;
    }
    if (planned && !served && item !== null && dataId && !ctx.unavailable.has(dataId)) {
      issue(ctx, "read_model_unavailable", ptr(path, key), `${key} is not served yet`);
    }
    param(ctx, def, item, ptr(path, key));
  }
  for (const [key, def] of Object.entries(model.params)) {
    if (def.required && (!Object.hasOwn(value, key) || value[key] === null)) {
      issue(ctx, "bad_params", ptr(path, key), `${key} is required`);
    }
  }
}

const paramNameCache = new WeakMap<ReadModelRegistry, ReadonlySet<string>>();
function paramNames(registry: ReadModelRegistry): ReadonlySet<string> {
  let names = paramNameCache.get(registry);
  if (!names) {
    names = new Set(
      Object.values(registry)
        .filter(isReadModelEntry)
        .flatMap((model) => [...Object.keys(model.params), ...Object.keys(model.planned_params)]),
    );
    paramNameCache.set(registry, names);
  }
  return names;
}

function param(ctx: Ctx, def: ParamDef, value: unknown, path: string): void {
  if (value === null) {
    if (def.required) issue(ctx, "bad_params", path, "this param is required");
    return;
  }
  let ok: boolean;
  switch (def.kind) {
    case "id":
      ok = typeof value === "string" && ID_VALUE.test(value);
      break;
    case "token":
      ok = typeof value === "string" && TOKEN.test(value);
      break;
    case "text":
      ok =
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= TEXT_PARAM &&
        !hasBadCharacter(value);
      break;
    case "boolean":
      ok = typeof value === "boolean";
      break;
    case "integer":
      ok =
        Number.isSafeInteger(value) && (value as number) >= def.min && (value as number) <= def.max;
      break;
    case "duration":
      ok =
        typeof value === "string" &&
        value.length <= 32 &&
        DURATION.test(value) &&
        /\d/.test(value) &&
        !value.endsWith("T");
      break;
    case "action_id":
      ok = typeof value === "string" && ctx.catalog.actions.has(value);
      break;
    case "specialist_id":
      ok = typeof value === "string" && ctx.catalog.specialists.has(value);
      break;
  }
  if (!ok) issue(ctx, "bad_params", path, `not a valid ${def.kind} param`);
}

function sources(ctx: Ctx, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    issue(ctx, "wrong_type", path, "sources is an array");
    return;
  }
  if (value.length === 0) {
    issue(ctx, "missing_sources", path, "every data entry cites at least one fact");
    return;
  }
  if (value.length > LIMITS.sources) {
    issue(ctx, "limit_exceeded", path, `a data entry cites at most ${LIMITS.sources} facts`);
  }
  value.slice(0, LIMITS.sources).forEach((raw, index) => {
    const at = `${path}/${index}`;
    if (!isRecord(raw)) {
      issue(ctx, "bad_source", at, "a source is {fact_id, version, hash}");
      return;
    }
    keys(ctx, raw, at, SOURCE_KEYS);
    const factId = get(raw, "fact_id");
    if (
      Object.hasOwn(raw, "fact_id") &&
      (typeof factId !== "string" || factId.length > LIMITS.fact_id || !FACT_ID.test(factId))
    ) {
      issue(
        ctx,
        "bad_source",
        `${at}/fact_id`,
        "fact_id is <object>/<id>, evidence/<id> or <provider>/<entity>/<id>",
      );
    }
    const version = get(raw, "version");
    if (
      Object.hasOwn(raw, "version") &&
      !(Number.isSafeInteger(version) && (version as number) >= 0)
    ) {
      issue(ctx, "bad_source", `${at}/version`, "version is a whole number, zero or more");
    }
    const hash = get(raw, "hash");
    if (Object.hasOwn(raw, "hash") && (typeof hash !== "string" || !HASH.test(hash))) {
      issue(ctx, "bad_source", `${at}/hash`, "hash is sha256: and 64 hex digits");
    }
  });
}

// --- actions and links -----------------------------------------------------------------------

function actions(ctx: Ctx, value: unknown): void {
  if (!Array.isArray(value)) {
    issue(ctx, "wrong_type", "/actions", "actions is an array");
    return;
  }
  if (value.length > LIMITS.actions) {
    issue(ctx, "limit_exceeded", "/actions", `a view offers at most ${LIMITS.actions} actions`);
  }
  const offered = value.slice(0, LIMITS.actions);
  ctx.actionCount = offered.length;
  offered.forEach((raw, index) => action(ctx, raw, `/actions/${index}`));
}

function action(ctx: Ctx, raw: unknown, path: string): void {
  if (ctx.place && !ctx.place.actions) {
    issue(ctx, "place_not_allowed", path, "views here are read-only");
  }
  if (!isRecord(raw)) {
    issue(ctx, "wrong_type", path, "an action is an object");
    return;
  }
  keys(ctx, raw, path, ACTION_KEYS);
  const id = get(raw, "action_id");
  let request: ActionRequestKind | null = null;
  if (typeof id !== "string" || !ctx.catalog.actions.has(id)) {
    issue(ctx, "unknown_action", `${path}/action_id`, "action_id is not in the catalog");
  } else {
    const entry = ctx.catalog.actions.get(id) as ViewSpecCatalogAction;
    const at = `${path}/action_id`;
    if (entry.owners.length === 0) issue(ctx, "action_not_owned", at, "no specialist owns it");
    if (entry.autonomy === "H" || entry.human_only) {
      issue(ctx, "action_people_only", at, "people only: reach it through a link to its decision");
    } else if (entry.autonomy === "A0") {
      issue(ctx, "action_read_only", at, "a read is not an action a person presses");
    } else if (OWNER_CONTROLS.includes(entry.aggregate)) {
      issue(ctx, "action_owner_control", at, "the AI team's own controls change only in Settings");
    } else if (RUN_ONLY_ACTIONS.includes(entry.action_id)) {
      issue(
        ctx,
        "action_run_only",
        at,
        "a specialist's run takes this step; a view shows its receipt",
      );
    } else if (entry.autonomy !== "A3" && OUTSIDE_EFFECTS.includes(entry.side_effect_class)) {
      issue(
        ctx,
        "action_outside_effect",
        at,
        "an effect outside the company asks first: offer an A3 request",
      );
    }
    request = actionRequestKind(entry);
  }
  if (Object.hasOwn(raw, "label")) {
    if (isRecord(raw.label)) {
      // Words the read model wrote for this control; the renderer checks them as it draws them.
      const found = binding(ctx, raw.label, `${path}/label`, true);
      if (found && (found.is !== "value" || found.type !== "label")) {
        issue(ctx, "field_type_mismatch", `${path}/label`, "a bound label reads a label field");
      }
    } else {
      label(
        ctx,
        raw.label,
        `${path}/label`,
        request === "prepare_for_approval" ? "request" : "act",
      );
    }
  }
  const target = get(raw, "target");
  if (target !== undefined && target !== null) {
    const found = binding(ctx, target, `${path}/target`, true);
    if (found && (found.is !== "value" || (found.type !== "id" && found.type !== "proposal"))) {
      issue(ctx, "action_target_unbound", `${path}/target`, "the target binds an id or a proposal");
    }
  }
  flag(ctx, get(raw, "primary"), `${path}/primary`, Object.hasOwn(raw, "primary"));
}

function links(ctx: Ctx, value: unknown): void {
  if (!Array.isArray(value)) {
    issue(ctx, "wrong_type", "/links", "links is an array");
    return;
  }
  if (value.length > LIMITS.links) {
    issue(ctx, "limit_exceeded", "/links", `a view has at most ${LIMITS.links} links`);
  }
  const listed = value.slice(0, LIMITS.links);
  ctx.linkCount = listed.length;
  listed.forEach((raw, index) => link(ctx, raw, `/links/${index}`));
}

function link(ctx: Ctx, raw: unknown, path: string): void {
  if (!isRecord(raw)) {
    issue(ctx, "wrong_type", path, "a link is an object");
    return;
  }
  keys(ctx, raw, path, LINK_KEYS);
  const surface = get(raw, "surface");
  const rule =
    typeof surface === "string" && Object.hasOwn(LINK_SURFACES, surface)
      ? LINK_SURFACES[surface as LinkSurface]
      : null;
  if (!rule) {
    issue(ctx, "unknown_surface", `${path}/surface`, "surface is not a link surface");
  } else if (ctx.place && !ctx.place.surfaces.includes(surface as LinkSurface)) {
    issue(ctx, "place_not_allowed", `${path}/surface`, "this surface does not open here");
  }
  const id = get(raw, "id");
  if (rule && Object.hasOwn(raw, "id")) {
    const at = `${path}/id`;
    if (rule.id === "none") {
      if (id !== null) issue(ctx, "bad_link_id", at, `a ${String(surface)} link has no id`);
    } else if (rule.id === "manual") {
      if (typeof id !== "string") {
        issue(ctx, "bad_link_id", at, "a manual link names its screen");
      } else if (ctx.template && !ctx.template.manual.includes(id)) {
        issue(ctx, "unknown_surface", at, "not a manual screen of this template");
      }
    } else if (typeof id === "string") {
      if (!ID_VALUE.test(id)) issue(ctx, "bad_link_id", at, "not a valid id");
    } else if (isRecord(id)) {
      const found = binding(ctx, id, at, false);
      if (found && (found.is !== "value" || found.type !== "id")) {
        issue(ctx, "bad_link_id", at, "the id binds an id field");
      }
    } else {
      issue(ctx, "bad_link_id", at, `a ${String(surface)} link needs an id`);
    }
  }
  if (Object.hasOwn(raw, "label")) {
    label(ctx, raw.label, `${path}/label`, "link", rule?.label ?? null);
  }
  flag(ctx, get(raw, "primary"), `${path}/primary`, Object.hasOwn(raw, "primary"));
}

// --- slots and components --------------------------------------------------------------------

function slots(ctx: Ctx, value: unknown): void {
  if (!isRecord(value)) {
    issue(ctx, "wrong_type", "/slots", "slots is an object");
    return;
  }
  // The body comes first: the filter bar refers to the collections it binds.
  const names = Object.keys(value).sort((a, b) => Number(b === "body") - Number(a === "body"));
  for (const name of names) {
    const raw = value[name];
    const path = ptr("/slots", name);
    if (!SLOT_NAMES.includes(name as SlotName)) {
      issue(ctx, "unknown_slot", path, "not a slot name");
      continue;
    }
    const rule = ctx.template ? own(ctx.template.slots, name) : undefined;
    if (ctx.template && !rule) {
      if (raw === null || (Array.isArray(raw) && raw.length === 0)) continue;
      issue(ctx, "unknown_slot", path, `the ${ctx.templateId} template has no ${name} slot`);
      continue;
    }
    if (raw === null) continue;
    if (!Array.isArray(raw)) {
      issue(ctx, "wrong_type", path, "a slot is an array of components");
      continue;
    }
    if (rule && (raw.length < rule.min || raw.length > rule.max)) {
      issue(ctx, "slot_count", path, `${name} holds ${rule.min} to ${rule.max} components`);
    }
    raw.forEach((component, index) =>
      componentAt(ctx, component, `${path}/${index}`, name as SlotName, rule ?? null),
    );
    if (
      name === "summary" &&
      raw.length > 1 &&
      raw.some((c) => isRecord(c) && c.kind === "summary_cells")
    ) {
      issue(ctx, "slot_count", path, "summary cells stand alone in the summary");
    }
  }
  if (ctx.template) {
    for (const [name, rule] of Object.entries(ctx.template.slots) as [SlotName, SlotRule][]) {
      const raw = value[name];
      const missing = !Object.hasOwn(value, name) || raw === null;
      if (rule.min > 0 && missing) {
        issue(
          ctx,
          "slot_count",
          ptr("/slots", name),
          `${name} holds ${rule.min} to ${rule.max} components`,
        );
      }
    }
  }
}

function componentAt(
  ctx: Ctx,
  raw: unknown,
  path: string,
  slotName: SlotName,
  rule: SlotRule | null,
): void {
  ctx.components += 1;
  if (ctx.components === LIMITS.components + 1) {
    issue(ctx, "limit_exceeded", path, `a view has at most ${LIMITS.components} components`);
  }
  if (ctx.components > LIMITS.components) return;
  if (!isRecord(raw)) {
    issue(ctx, "wrong_type", path, "a component is an object");
    return;
  }
  const kind = get(raw, "kind");
  if (typeof kind !== "string" || !Object.hasOwn(COMPONENTS, kind)) {
    issue(ctx, "unknown_component", `${path}/kind`, "kind is not a component kind");
    return;
  }
  const defs: Readonly<Record<string, PropDef>> = COMPONENTS[kind as ComponentKind];
  if (rule && !rule.kinds.includes(kind as ComponentKind)) {
    issue(
      ctx,
      "component_not_allowed_in_slot",
      `${path}/kind`,
      `${kind} does not go in ${slotName}`,
    );
  }
  keys(ctx, raw, path, ["kind", ...Object.keys(defs)], ALL_PROPS);
  const scope = props(ctx, raw, defs, path, null);
  if (slotName === "body") {
    for (const found of scope.collections.values()) if (found) ctx.bodyCollections.push(found);
  }
  kindChecks(ctx, kind as ComponentKind, raw, path, scope, slotName);
}

function props(
  ctx: Ctx,
  raw: Record<string, unknown>,
  defs: Readonly<Record<string, PropDef>>,
  path: string,
  parent: Scope | null,
): Scope {
  const scope: Scope = { parent, collections: new Map() };
  for (const [name, def] of Object.entries(defs)) {
    if (Object.hasOwn(raw, name)) prop(ctx, raw[name], def, ptr(path, name), name, scope);
  }
  return scope;
}

function prop(
  ctx: Ctx,
  raw: unknown,
  def: PropDef,
  path: string,
  name: string,
  scope: Scope,
): void {
  switch (def.is) {
    case "words":
      if (raw === null && def.nullable) return;
      literal(ctx, raw, path);
      return;
    case "value": {
      if (raw === null && def.nullable) return;
      accept(ctx, binding(ctx, raw, path, false), path, def.types);
      return;
    }
    case "values": {
      if (!Array.isArray(raw)) {
        issue(ctx, "wrong_type", path, "a list of bindings");
        return;
      }
      if (raw.length > def.max) issue(ctx, "limit_exceeded", path, `at most ${def.max}`);
      raw.slice(0, def.max).forEach((item, index) => {
        const at = `${path}/${index}`;
        accept(ctx, binding(ctx, item, at, false), at, def.types);
      });
      return;
    }
    case "rows": {
      const found = binding(ctx, raw, path, false);
      let usable: Collection | null = null;
      if (found && found.is !== "rows") {
        issue(ctx, "field_type_mismatch", path, "this binds a value; it needs a collection");
      } else if (found && def.rows !== "any" && found.kind !== def.rows) {
        issue(
          ctx,
          "field_type_mismatch",
          path,
          `it needs ${def.rows} rows, not ${found.kind} rows`,
        );
      } else if (found) {
        usable = found.collection;
      }
      scope.collections.set(name, usable);
      return;
    }
    case "row": {
      const found = binding(ctx, raw, path, false);
      if (found && (found.is !== "row" || found.kind !== def.rows)) {
        issue(ctx, "field_type_mismatch", path, `it needs one ${def.rows} row, by its item number`);
      }
      return;
    }
    case "field":
      if (raw === null && def.nullable) return;
      fieldOf(ctx, raw, path, def.of, def.types, scope);
      return;
    case "fields": {
      if (!Array.isArray(raw)) {
        issue(ctx, "wrong_type", path, "a list of row fields");
        return;
      }
      if (raw.length > def.max) issue(ctx, "limit_exceeded", path, `at most ${def.max}`);
      raw
        .slice(0, def.max)
        .forEach((item, index) => fieldOf(ctx, item, `${path}/${index}`, def.of, def.types, scope));
      return;
    }
    case "objects": {
      if (!Array.isArray(raw)) {
        issue(ctx, "wrong_type", path, "a list of objects");
        return;
      }
      if (raw.length < def.min || raw.length > def.max) {
        issue(ctx, "limit_exceeded", path, `${def.min} to ${def.max} entries`);
      }
      raw.slice(0, def.max).forEach((item, index) => {
        const at = `${path}/${index}`;
        if (!isRecord(item)) {
          issue(ctx, "wrong_type", at, "an object");
          return;
        }
        keys(ctx, item, at, Object.keys(def.props));
        props(ctx, item, def.props, at, scope);
      });
      return;
    }
    case "choice":
      if (typeof raw !== "string" || !def.values.includes(raw)) {
        issue(ctx, "wrong_type", path, `one of ${def.values.join(", ")}`);
      }
      return;
    case "primary":
      flag(ctx, raw, path, true);
      return;
    case "index": {
      if (raw === null) return;
      const count = def.into === "actions" ? ctx.actionCount : ctx.linkCount;
      if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
        issue(ctx, "wrong_type", path, `an item number into ${def.into}, or null`);
      } else if ((raw as number) >= count) {
        issue(ctx, "bad_index", path, `there is no ${def.into} item ${String(raw)}`);
      }
      return;
    }
    case "token":
      if (typeof raw !== "string" || !TOKEN.test(raw)) {
        issue(ctx, "wrong_type", path, "a lower-case token");
      }
      return;
    case "totals":
      if (raw === null) return;
      if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
        issue(ctx, "wrong_type", path, "column labels, or null");
      } else if (raw.length > LIMITS.table_columns || new Set(raw).size !== raw.length) {
        issue(ctx, "wrong_type", path, "each column is totalled at most once");
      }
      return;
  }
}

function kindChecks(
  ctx: Ctx,
  kind: ComponentKind,
  raw: Record<string, unknown>,
  path: string,
  scope: Scope,
  slotName: SlotName,
): void {
  if (kind === "table") {
    const rowsOf = scope.collections.get("rows");
    const columns = Array.isArray(raw.columns) ? raw.columns.slice(0, LIMITS.table_columns) : [];
    const byLabel = new Map<string, Resolved | undefined>();
    const fields = new Set<string>();
    columns.forEach((column, index) => {
      if (!isRecord(column)) return;
      const resolved = ctx.fieldTypes.get(`${path}/columns/${index}/field`);
      if (typeof column.label === "string") byLabel.set(column.label, resolved);
      if (isRecord(column.field) && typeof column.field.field === "string") {
        fields.add(column.field.field);
      }
    });
    if (rowsOf) ctx.tables.push({ collection: collectionKey(rowsOf), fields });
    if (slotName === "body") ctx.bodyTables += 1;
    if (Array.isArray(raw.total)) {
      raw.total.forEach((name, index) => {
        if (typeof name !== "string") return;
        const at = `${path}/total/${index}`;
        if (!byLabel.has(name)) {
          issue(ctx, "total_not_a_column", at, "a total names one of this table's column labels");
          return;
        }
        const resolved = byLabel.get(name);
        if (resolved?.is === "value" && !SUMMABLE.includes(resolved.type)) {
          issue(ctx, "field_type_mismatch", at, `a ${resolved.type} column has no total`);
        }
      });
    }
  } else if (kind === "chart") {
    ctx.charts += 1;
    if (ctx.charts > LIMITS.charts) {
      issue(ctx, "limit_exceeded", path, `a view has at most ${LIMITS.charts} charts`);
    }
    const series = Array.isArray(raw.series) ? raw.series.slice(0, LIMITS.chart_series) : [];
    series.forEach((item, index) => {
      if (!isRecord(item)) return;
      const points = item.points;
      const x = isRecord(item.x) ? item.x.field : undefined;
      const y = isRecord(item.y) ? item.y.field : undefined;
      if (isRecord(points) && typeof points.bind === "string" && typeof points.path === "string") {
        ctx.series.push({
          path: `${path}/series/${index}`,
          collection: `${points.bind}${points.path}`,
          x: typeof x === "string" ? x : "",
          y: typeof y === "string" ? y : "",
        });
      }
    });
  } else if (kind === "comparison_columns") {
    const versus = isRecord(raw.versus) ? raw.versus.field : undefined;
    const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
    const named = criteria.some(
      (item) => isRecord(item) && isRecord(item.field) && item.field.field === versus,
    );
    if (typeof versus === "string" && !named) {
      issue(ctx, "versus_not_a_criterion", `${path}/versus`, "versus names one of the criteria");
    }
  } else if (kind === "empty_hint") {
    if (
      raw.link !== null &&
      raw.link !== undefined &&
      raw.action !== null &&
      raw.action !== undefined
    ) {
      issue(ctx, "two_next_steps", path, "an empty hint offers one next step: a link or an action");
    }
  }
}

function crossChecks(ctx: Ctx): void {
  for (const { name, path } of ctx.filterFields) {
    const hits = ctx.bodyCollections
      .map((found) => lookup(found.entry, `${found.pattern}/*/${name}`))
      .filter((hit) => hit !== undefined);
    if (hits.length === 0) {
      issue(ctx, "unknown_field_path", path, "a filter names a field of a collection in the body");
    } else if (!hits.some((hit) => hit.descriptor === "state")) {
      issue(ctx, "field_type_mismatch", path, "a filter compares a state field");
    }
  }
  for (const series of ctx.series) {
    const twin = ctx.tables.some(
      (table) =>
        table.collection === series.collection &&
        table.fields.has(series.x) &&
        table.fields.has(series.y),
    );
    if (!twin) {
      issue(
        ctx,
        "chart_without_table",
        series.path,
        "every chart has a table of the same rows and fields",
      );
    }
  }
  if (ctx.templateId === "report" && ctx.bodyTables === 0) {
    issue(ctx, "slot_count", "/slots/body", "a report body holds at least one table");
  }
  if (ctx.primaries.length > 1) {
    for (const path of ctx.primaries) {
      issue(ctx, "primary_count", path, "at most one control in a view is primary");
    }
  }
}

// --- bindings --------------------------------------------------------------------------------

function binding(ctx: Ctx, raw: unknown, path: string, rowAction: boolean): Resolved | null {
  if (!isRecord(raw)) {
    issue(ctx, "wrong_type", path, "a binding is {bind, path}");
    return null;
  }
  keys(ctx, raw, path, BINDING_KEYS);
  const bind = get(raw, "bind");
  const pointer = get(raw, "path");
  if (bind === undefined || pointer === undefined) return null;
  if (typeof bind !== "string" || !ctx.data.has(bind)) {
    issue(ctx, "unbound_binding", `${path}/bind`, "bind names no declared data entry");
    return null;
  }
  if (typeof pointer !== "string" || !POINTER.test(pointer)) {
    issue(
      ctx,
      "bad_path",
      `${path}/path`,
      "path is a JSON pointer of field names and item numbers",
    );
    return null;
  }
  if (!rowAction && pointer.includes("*")) {
    issue(ctx, "bad_path", `${path}/path`, "only a row action takes *; name an item by its number");
    return null;
  }
  const model = ctx.data.get(bind);
  if (!model) return null;
  const pattern = pointer.replace(/\/(?:0|[1-9][0-9]*)(?=\/|$)/g, "/*");
  return resolve(ctx, bind, model, pattern, pointer, `${path}/path`);
}

function fieldOf(
  ctx: Ctx,
  raw: unknown,
  path: string,
  of: string,
  types: Types,
  scope: Scope,
): void {
  if (!isRecord(raw)) {
    issue(ctx, "wrong_type", path, "a row field is {field}");
    return;
  }
  keys(ctx, raw, path, FIELD_KEYS);
  const name = get(raw, "field");
  if (name === undefined) return;
  if (typeof name !== "string" || !FIELD_NAME.test(name)) {
    issue(ctx, "bad_path", `${path}/field`, "a row field is one field name");
    return;
  }
  if (of === BODY) {
    ctx.filterFields.push({ name, path: `${path}/field` });
    return;
  }
  const base = collectionIn(scope, of);
  if (!base) return;
  // The collection's own binding has passed the place rules already.
  const found = resolve(
    ctx,
    base.dataId,
    base.entry,
    `${base.pattern}/*/${name}`,
    name,
    `${path}/field`,
    false,
  );
  if (found) ctx.fieldTypes.set(path, found);
  accept(ctx, found, `${path}/field`, types);
}

function collectionIn(scope: Scope | null, name: string): Collection | null {
  for (let at = scope; at; at = at.parent) {
    if (at.collections.has(name)) return at.collections.get(name) ?? null;
  }
  return null;
}

function lookup(
  model: ReadModelEntry,
  pattern: string,
): { readonly descriptor: FieldDescriptor; readonly planned: boolean } | undefined {
  const served = own(model.fields, pattern);
  if (served !== undefined) return { descriptor: served, planned: false };
  const planned = own(model.planned_fields, pattern);
  return planned === undefined ? undefined : { descriptor: planned, planned: true };
}

function resolve(
  ctx: Ctx,
  dataId: string,
  model: ReadModelEntry,
  pattern: string,
  exact: string,
  path: string,
  placeRules = true,
): Resolved | null {
  let hit = lookup(model, pattern);
  let oneRow = false;
  if (!hit && pattern.endsWith("/*")) {
    hit = lookup(model, pattern.slice(0, -2));
    oneRow = true;
  }
  if (!hit || (oneRow && !isRows(hit.descriptor))) {
    issue(ctx, "unknown_field_path", path, "the read model does not publish this path");
    return null;
  }
  if (hit.planned && !ctx.unavailable.has(dataId)) {
    issue(ctx, "read_model_unavailable", path, "the read model does not serve this path yet");
  }
  const descriptor = hit.descriptor;
  const refused = placeRules ? refusedRows(ctx, model, pattern, descriptor) : null;
  if (refused) issue(ctx, "place_not_allowed", path, `${refused} rows open office surfaces only`);
  if (isRows(descriptor)) {
    return oneRow
      ? { is: "row", kind: descriptor.rows }
      : { is: "rows", kind: descriptor.rows, collection: { dataId, entry: model, pattern, exact } };
  }
  if (typeof descriptor === "string") return { is: "value", type: descriptor, surfaces: [] };
  return { is: "value", type: "link", surfaces: descriptor.link };
}

/** A row kind this place refuses, reached as the bound collection or as one of its items. */
function refusedRows(
  ctx: Ctx,
  model: ReadModelEntry,
  pattern: string,
  descriptor: FieldDescriptor,
): RowKind | null {
  const refused = ctx.place?.refusedRows ?? [];
  if (refused.length === 0) return null;
  const kinds: RowKind[] = isRows(descriptor) ? [descriptor.rows] : [];
  const segments = pattern.split("/");
  segments.forEach((segment, index) => {
    if (segment !== "*") return;
    const above = lookup(model, segments.slice(0, index).join("/"))?.descriptor;
    if (above !== undefined && isRows(above)) kinds.push(above.rows);
  });
  return kinds.find((kind) => refused.includes(kind)) ?? null;
}

function accept(ctx: Ctx, found: Resolved | null, path: string, types: Types): void {
  if (!found) return;
  if (found.is !== "value") {
    issue(
      ctx,
      "field_type_mismatch",
      path,
      `this binds a ${found.is === "rows" ? "collection" : "row"}; it needs a value`,
    );
    return;
  }
  if (!types.includes(found.type)) {
    issue(ctx, "field_type_mismatch", path, `it takes ${types.join(", ")}, not ${found.type}`);
    return;
  }
  if (ctx.place && !ctx.place.money && found.type === "money") {
    issue(ctx, "place_not_allowed", path, "no money is shown here");
  }
  const surfaces = ctx.place?.surfaces;
  if (surfaces && found.surfaces.some((surface) => !surfaces.includes(surface))) {
    issue(ctx, "place_not_allowed", path, "this row link opens a surface that does not open here");
  }
}

function collectionKey(found: Collection): string {
  return `${found.dataId}${found.exact}`;
}

function isReadModelEntry(raw: unknown): raw is ReadModelEntry {
  return (
    isRecord(raw) &&
    typeof raw.available === "boolean" &&
    (raw.path === null || typeof raw.path === "string") &&
    isRecord(raw.params) &&
    isRecord(raw.fields) &&
    isRecord(raw.planned_params) &&
    isRecord(raw.planned_fields)
  );
}

function isRows(descriptor: FieldDescriptor): descriptor is { readonly rows: RowKind } {
  return typeof descriptor === "object" && "rows" in descriptor;
}

// --- literals --------------------------------------------------------------------------------

function literal(ctx: Ctx, raw: unknown, path: string): void {
  if (typeof raw !== "string") {
    issue(ctx, "wrong_type", path, "literal words are a string");
    return;
  }
  if (raw.trim() === "") {
    issue(ctx, "literal_empty", path, "literal words are not empty");
    return;
  }
  // A literal over the limit is refused already; only its start is read further, so a long one
  // cannot make the word checks below slow.
  let text = raw;
  if ([...raw].length > LIMITS.literal) {
    issue(ctx, "literal_too_long", path, `literal words are at most ${LIMITS.literal} characters`);
    text = raw.slice(0, 4 * LIMITS.literal);
  }
  if (DIGITS.test(text)) issue(ctx, "literal_has_digits", path, "numbers are facts: bind them");
  if (CURRENCY.test(text)) issue(ctx, "literal_has_currency", path, "money is a fact: bind it");
  if (MARKUP.test(text)) issue(ctx, "literal_has_markup", path, "no markup in words");
  if (hasBadLiteralCharacter(text)) {
    issue(ctx, "literal_bad_character", path, "only letters, spaces and plain punctuation");
  }
  // The word rules read the folded text, so an accent cannot hide a word.
  const words = fold(text);
  if (URL_LIKE.test(words)) issue(ctx, "literal_has_url", path, "no addresses or links in words");
  if (NUMBER_WORDS.test(words)) {
    issue(ctx, "literal_has_number_words", path, "numbers and money in words are facts: bind them");
  }
  const banned = BANNED_TERMS.filter(([, rule]) => rule.test(words)).map(([term]) => term);
  const name = unknownAiName(words, ctx.catalog.aiNames);
  if (name) banned.push(`AI name "${name}"`);
  if (banned.length > 0) {
    issue(ctx, "literal_banned_term", path, `banned on primary surfaces: ${banned.join(", ")}`);
  }
  if (DELEGATION_WORDS.test(words)) {
    issue(ctx, "literal_delegation_words", path, "delegation words come from the renderer");
  }
}

/** Accents removed and the letters in FOLD replaced: the text the word rules read. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ıłŁøØđĐðÐħĦŧŦĸæÆœŒßþÞ]/g, (letter) => FOLD[letter] ?? letter);
}

function label(
  ctx: Ctx,
  raw: unknown,
  path: string,
  control: "act" | "request" | "link",
  start: SurfaceRule["label"] = null,
): void {
  literal(ctx, raw, path);
  if (typeof raw !== "string" || raw.trim() === "") return;
  const text = fold(raw.trim().slice(0, 4 * LIMITS.literal));
  if (text.split(/\s+/).length < 2 || BANNED_START.test(text)) {
    issue(ctx, "control_label_not_verb_object", path, "a control label is a verb and its object");
  }
  if ((FRAMED_LABEL.test(text) ? FRAMED_DECISION_VERB : DECISION_VERB).test(text)) {
    issue(ctx, "control_label_decision_verb", path, "decisions happen on their own screen");
  }
  if (control === "request" && !REQUEST_LABEL.test(text)) {
    issue(
      ctx,
      "action_asks_first_not_offered_as_request",
      path,
      'it reads "Prepare … for your approval"',
    );
  }
  if (control === "act" && PROMISES_APPROVAL.test(text)) {
    issue(
      ctx,
      "action_label_promises_approval",
      path,
      "this action acts; it does not ask for approval",
    );
  }
  if (start && !text.startsWith(`${start.start} `)) {
    issue(ctx, start.code, path, `this link starts with "${start.start}"`);
  }
}

function unknownAiName(text: string, allowed: readonly string[]): string | null {
  for (const match of text.matchAll(/\bAI\b/g)) {
    const rest = text.slice(match.index);
    const known = allowed.some(
      (name) => rest.startsWith(name) && !/^[\p{L}\p{N}_]/u.test(rest.slice(name.length)),
    );
    if (!known) return rest.slice(0, 24);
  }
  return null;
}

function hasBadLiteralCharacter(text: string): boolean {
  if (text.normalize("NFKC") !== text) return true;
  for (const char of text) {
    if (DIGITS.test(char) || CURRENCY.test(char) || MARKUP.test(char)) continue;
    if (!LITERAL_CHARACTER.test(char) || LOOKALIKE_LETTER.test(char)) return true;
  }
  return false;
}

function hasBadCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

// --- small helpers ---------------------------------------------------------------------------

function indexCatalog(catalog: unknown): CatalogIndex {
  const valid =
    isRecord(catalog) &&
    typeof catalog.sha256 === "string" &&
    SHA256_HEX.test(catalog.sha256) &&
    Array.isArray(catalog.actions) &&
    catalog.actions.every(isCatalogAction) &&
    Array.isArray(catalog.specialists) &&
    catalog.specialists.every(isCatalogSpecialist);
  if (!valid) {
    return {
      valid,
      sha256: null,
      actions: new Map(),
      specialists: new Set(),
      aiNames: ["AI team"],
    };
  }
  const { sha256, actions, specialists } = catalog as unknown as ViewSpecCatalog;
  const aiNames = specialists.map((item) => item.display_name).filter((name) => /^AI\s/.test(name));
  return {
    valid,
    sha256,
    actions: new Map(actions.map((item) => [item.action_id, item])),
    specialists: new Set(specialists.map((item) => item.specialist_id)),
    aiNames: ["AI team", ...aiNames].sort((a, b) => b.length - a.length),
  };
}

function keys(
  ctx: Ctx,
  raw: Record<string, unknown>,
  path: string,
  expected: readonly string[],
  fillers?: ReadonlySet<string>,
): void {
  for (const key of Object.keys(raw)) {
    if (expected.includes(key)) continue;
    if (fillers?.has(key) && raw[key] === null) continue;
    issue(ctx, "unknown_key", ptr(path, key), `${quote(key)} is not part of this object`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(raw, key)) issue(ctx, "missing_key", ptr(path, key), `${key} is required`);
  }
}

function pattern(
  ctx: Ctx,
  raw: Record<string, unknown>,
  key: string,
  path: string,
  rule: RegExp,
  detail: string,
): void {
  if (!Object.hasOwn(raw, key)) return;
  const item = raw[key];
  if (typeof item !== "string" || !rule.test(item)) issue(ctx, "bad_id", ptr(path, key), detail);
}

function flag(ctx: Ctx, raw: unknown, path: string, present: boolean): void {
  if (!present) return;
  if (typeof raw !== "boolean") {
    issue(ctx, "wrong_type", path, "primary is true or false");
  } else if (raw) {
    ctx.primaries.push(path);
  }
}

function issue(ctx: Ctx, code: ViewSpecIssueCode, path: string, detail: string): void {
  ctx.issues.push({ code, path, detail });
}

function get(raw: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901: `~` and `/` in a key are escaped. */
function ptr(path: string, key: string): string {
  return `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function quote(key: string): string {
  return JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
}

function placeName(options: ViewSpecOptions | undefined): string {
  return typeof options?.place === "string" ? quote(options.place) : "this place";
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** False for text with a lone surrogate, which no page can draw or put in a URL. */
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    }
  }
  return true;
}

/**
 * Walks a value without running its accessors: only null, booleans, finite numbers, strings,
 * arrays and plain objects of well-formed text pass, at most `LIMITS.depth` containers below the
 * root, and no more values or characters than a JSON text within `LIMITS.bytes` could hold.
 */
function measure(root: unknown): Shape {
  const stack: [unknown, number][] = [[root, 0]];
  let nodes = 0;
  let chars = 0;
  while (stack.length > 0) {
    const [item, depth] = stack.pop() as [unknown, number];
    nodes += 1;
    if (nodes > LIMITS.nodes) return "too_large";
    if (typeof item === "string") {
      chars += item.length;
      if (chars > LIMITS.bytes) return "too_large";
      if (!wellFormed(item)) return "not_json";
      continue;
    }
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return "not_json";
      continue;
    }
    if (typeof item !== "object") return "not_json";
    if (depth > LIMITS.depth) return "too_deep";
    const isArray = Array.isArray(item);
    if (isArray && item.length > LIMITS.nodes) return "too_large";
    const proto: unknown = Object.getPrototypeOf(item);
    if (!isArray && proto !== Object.prototype && proto !== null) return "not_json";
    const names = isArray ? Array.from({ length: item.length }, (_, index) => String(index)) : [];
    for (const key of isArray ? names : Object.keys(item)) {
      if (!isArray) chars += key.length;
      if (chars > LIMITS.bytes) return "too_large";
      if (!isArray && !wellFormed(key)) return "not_json";
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !("value" in property)) return "not_json";
      stack.push([property.value, depth + 1]);
    }
  }
  return "ok";
}
