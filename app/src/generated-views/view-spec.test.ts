import { describe, expect, it } from "vitest";

import { accountingIntentDetailResponseSchema } from "../accounting/money-contracts";
import { inventoryOverviewResponseSchema } from "../inventory/inventory-contracts";
import { jobHistoryResponseSchema } from "../jobs/job-history-contracts";
import { nowResponseSchema } from "../now/now-contracts";
import { ownerNowResponseSchema } from "../owner/owner-contracts";
import { operatorSearchReadModelSchema } from "../search/operator-search-contracts";
import {
  READ_MODEL_FIXTURES,
  TEMPLATE_EXAMPLES,
  everythingAvailable,
  materializeExample,
  toWireForm,
} from "./__fixtures__";
import { CATALOG_JSON, CATALOG_SHA256 } from "./contract-catalog";
import {
  COMPONENTS,
  LIMITS,
  READ_MODELS,
  TEMPLATES,
  VIEW_SPEC_ISSUE_CODES,
  VIEW_SPEC_RUN_ISSUE_CODES,
  actionRequestKind,
  catalogFromContractJson,
  validateViewSpec,
  viewSpecFallbackWords,
  viewSpecJsonSchema,
  type FieldDescriptor,
  type Place,
  type PropDef,
  type ReadModelRegistry,
  type ViewSpecCatalog,
  type ViewSpecIssue,
  type ViewSpecIssueCode,
} from "./view-spec";

// Specs are plain JSON that the tests take apart on purpose.
type Spec = any;

const catalog = catalogFromContractJson(CATALOG_JSON, CATALOG_SHA256);
/** The real contract as a newer one might read: an unknown field and one action with an unknown class. */
const futureCatalog = (() => {
  const contract = JSON.parse(CATALOG_JSON) as { actions: Record<string, unknown>[] };
  contract.actions = contract.actions.map((action) =>
    action.action_id === "followup.pause"
      ? { ...action, autonomy: "A4", shadow_mode: "new" }
      : { ...action, shadow_mode: "new" },
  );
  return catalogFromContractJson(JSON.stringify(contract), CATALOG_SHA256);
})();
const ALL = everythingAvailable(READ_MODELS);
const HASH = `sha256:${"a".repeat(64)}`;
const SOURCE = { fact_id: "job/job-example-0001", version: 4, hash: HASH };

function run(
  spec: unknown,
  place: Place = "office",
  readModels: ReadModelRegistry = ALL,
  against: ViewSpecCatalog = catalog,
) {
  return validateViewSpec(spec, against, { place, readModels });
}

function issuesOf(spec: unknown, place?: Place, readModels?: ReadModelRegistry): ViewSpecIssue[] {
  const result = run(spec, place, readModels);
  return result.ok ? [] : [...result.issues];
}

const example = (name: keyof typeof TEMPLATE_EXAMPLES): Spec =>
  materializeExample(TEMPLATE_EXAMPLES[name], CATALOG_SHA256);
const list = () => example("list_stuck_jobs");

function edit(spec: Spec, change: (draft: Spec) => void): Spec {
  const draft = structuredClone(spec);
  change(draft);
  return draft;
}

const noteAction = (label = "Add a note to the job") => ({
  action_id: "note.add",
  label,
  target: null,
  primary: false,
});

/** A list over GET /api/v1/owner/now as the Worker serves it today. */
function servedList(): Spec {
  return {
    schema: "ironwrap_view_spec_v1",
    spec_id: "vs_blocked_work",
    run_id: "run_face_blocked_work",
    specialist_id: "orchestrator",
    catalog_sha256: `sha256:${CATALOG_SHA256}`,
    template: "list",
    title: "Work that is blocked",
    data: [{ id: "owner", read_model: "owner_now", params: {}, sources: [SOURCE] }],
    slots: {
      status: [
        {
          kind: "status_line",
          counts: [
            {
              value: { bind: "owner", path: "/summary/blocked_gates" },
              one: "gate is blocked",
              other: "gates are blocked",
              zero: "No gate is blocked",
            },
          ],
        },
      ],
      body: [
        {
          kind: "list",
          heading: null,
          rows: { bind: "owner", path: "/exceptions" },
          title: { field: "title" },
          meta: [{ field: "why" }, { field: "due_at" }],
          state: null,
          proposed: null,
          link: null,
          primary: false,
        },
      ],
      empty: [
        {
          kind: "empty_hint",
          words: "Nothing is blocked. See what needs you on Now.",
          link: 0,
          action: null,
        },
      ],
    },
    actions: [],
    links: [{ surface: "now", id: null, label: "See what needs you", primary: false }],
  };
}

/** A record over GET /api/v1/jobs/{job}/history that a crew phone may draw. */
function servedCrewRecord(): Spec {
  return {
    ...servedList(),
    spec_id: "vs_job_events",
    template: "record",
    title: "What happened on this job",
    data: [
      {
        id: "history",
        read_model: "job_history",
        params: { job: "job-example-0001" },
        sources: [SOURCE],
      },
    ],
    slots: {
      heading: [
        {
          kind: "record_heading",
          name: { bind: "history", path: "/job/address" },
          identity: [{ bind: "history", path: "/job/job_number" }],
          kind_words: "Job history",
        },
      ],
      body: [
        {
          kind: "timeline",
          heading: "Photos and notes",
          items: { bind: "history", path: "/proof/items" },
          when: { field: "occurred_at" },
          actor: { field: "source" },
          actor_kind: null,
          what: { field: "summary" },
          detail: { field: "sync_state" },
          link: null,
        },
      ],
      empty: [
        {
          kind: "empty_hint",
          words: "Nothing has happened on this job yet.",
          link: 0,
          action: null,
        },
      ],
    },
    links: [{ surface: "now", id: null, label: "See today's work", primary: false }],
  };
}

/**
 * design/system-v2/TEMPLATES.md wording a literal rule refuses, pinned per example path until Track
 * B rewords it. Empty: every copied example validates.
 */
const TEMPLATES_WORDING: Partial<Record<keyof typeof TEMPLATE_EXAMPLES, string[]>> = {};
const wording = (name: keyof typeof TEMPLATE_EXAMPLES) =>
  (TEMPLATES_WORDING[name] ?? []).map((path) =>
    expect.objectContaining({ code: "literal_has_number_words", path }),
  );

describe("valid view specs", () => {
  it.each(Object.keys(TEMPLATE_EXAMPLES) as (keyof typeof TEMPLATE_EXAMPLES)[])(
    "accepts the TEMPLATES.md example %s, as text and as a value",
    (name) => {
      const spec = example(name);
      if (TEMPLATES_WORDING[name]) {
        expect(issuesOf(spec)).toEqual(wording(name));
        expect(issuesOf(JSON.stringify(spec))).toEqual(wording(name));
        return;
      }
      expect(run(spec)).toEqual({ ok: true, spec });
      expect(run(JSON.stringify(spec)).ok).toBe(true);
    },
  );

  it("accepts decision nouns in the fixed frames' objects", () => {
    const request = edit(
      example("schedule_crews_this_week"),
      (draft) => void (draft.actions[0].label = "Prepare the crew release for your approval"),
    );
    expect(run(request).ok).toBe(true);
    for (const [surface, id, label] of [
      ["decision", "decision-example-0001", "Review the refund request"],
      ["receipt", "step-example-0001", "See receipt for releasing the shop order"],
    ] as const) {
      const linked = edit(list(), (draft) => {
        draft.links[0] = { surface, id, label, primary: false };
      });
      expect(run(linked).ok, label).toBe(true);
    }
  });

  it("covers all six templates with the examples", () => {
    const templates = Object.values(TEMPLATE_EXAMPLES).map((spec) => spec.template);
    expect(new Set(templates)).toEqual(new Set(Object.keys(TEMPLATES)));
  });

  it("refuses every example until the read models it binds are served", () => {
    for (const name of Object.keys(TEMPLATE_EXAMPLES) as (keyof typeof TEMPLATE_EXAMPLES)[]) {
      const issues = issuesOf(example(name), "office", READ_MODELS);
      const unavailable = issues.filter((issue) => issue.code === "read_model_unavailable");
      expect(unavailable.length).toBeGreaterThan(0);
      expect(issues.filter((issue) => !unavailable.includes(issue))).toEqual(wording(name));
    }
  });

  it("accepts views over the read models the Worker serves today", () => {
    expect(run(servedList(), "office", READ_MODELS).ok).toBe(true);
    expect(run(servedCrewRecord(), "office", READ_MODELS).ok).toBe(true);
    expect(run(servedCrewRecord(), "crew", READ_MODELS).ok).toBe(true);
  });

  it("accepts the wire form the strict JSON Schema produces", () => {
    const schema = viewSpecJsonSchema({ catalog, readModels: ALL });
    for (const name of Object.keys(TEMPLATE_EXAMPLES) as (keyof typeof TEMPLATE_EXAMPLES)[]) {
      const wire = toWireForm(example(name), schema) as Spec;
      expect(Object.keys(wire.slots)).toHaveLength(8);
      expect(issuesOf(wire)).toEqual(wording(name));
    }
  });

  it("accepts a chart over the same rows and fields as its table twin", () => {
    const spec = edit(example("report_margin_watch"), (draft) => {
      draft.slots.body.push({
        kind: "chart",
        heading: "Cost so far by job",
        chart_kind: "bar",
        series: [
          {
            label: "Cost so far",
            points: { bind: "margins", path: "/jobs" },
            x: { field: "job" },
            y: { field: "cost_so_far" },
          },
        ],
      });
    });
    expect(issuesOf(spec)).toEqual(wording("report_margin_watch"));
  });

  it("accepts a receipt link that reads See receipt for its object", () => {
    const spec = edit(list(), (draft) => {
      draft.links.push({
        surface: "receipt",
        id: "step-example-0001",
        label: "See receipt for the deposit invoice",
        primary: false,
      });
    });
    expect(issuesOf(spec)).toEqual([]);
  });

  it("accepts row actions, view links and a literal link id", () => {
    const spec = edit(list(), (draft) => {
      draft.actions = [noteAction()];
      draft.links.push({
        surface: "decision",
        id: "decision-example-0001",
        label: "Review the work stop",
        primary: false,
      });
    });
    expect(issuesOf(spec)).toEqual([]);
  });
});

/** A caller-supplied registry whose every read throws. */
const THROWING_REGISTRY = new Proxy(
  {},
  {
    get() {
      throw new Error("trap");
    },
    getOwnPropertyDescriptor() {
      throw new Error("trap");
    },
    ownKeys() {
      throw new Error("trap");
    },
  },
) as unknown as ReadModelRegistry;

const CASES: [ViewSpecIssueCode, string, () => unknown, string, Place?][] = [
  [
    "action_not_recognized",
    "an action a newer contract gives a class this module does not know",
    () => ({
      spec: edit(list(), (draft) => {
        draft.actions = [{ ...noteAction("Pause the follow-up"), action_id: "followup.pause" }];
      }),
      catalog: futureCatalog,
    }),
    "/actions/0/action_id",
  ],
  ["not_json", "text that is not JSON", () => "{", ""],
  [
    "literal_has_number_words",
    "a count spelled out",
    () => ({ ...list(), title: "Three jobs are stuck" }),
    "/title",
  ],
  [
    "validator_failed",
    "a registry the validator cannot read",
    () => ({ spec: list(), registry: THROWING_REGISTRY }),
    "",
  ],
  [
    "too_large",
    "text over 64 KB",
    () => JSON.stringify({ ...list(), title: "a".repeat(70_000) }),
    "",
  ],
  [
    "too_deep",
    "arrays nested past six",
    () => ({ ...list(), slots: { body: [[[[[[["x"]]]]]]] } }),
    "",
  ],
  ["wrong_type", "a number for the title", () => ({ ...list(), title: 7 }), "/title"],
  [
    "unknown_key",
    "a style prop",
    () => edit(list(), (draft) => void (draft.slots.body[0].style = "color: red")),
    "/slots/body/0/style",
  ],
  ["missing_key", "no links", () => edit(list(), (draft) => void delete draft.links), "/links"],
  [
    "unknown_schema",
    "another schema",
    () => ({ ...list(), schema: "ironwrap_view_spec_v2" }),
    "/schema",
  ],
  ["bad_id", "a spec id with a space", () => ({ ...list(), spec_id: "vs bad" }), "/spec_id"],
  [
    "duplicate_data_id",
    "two data entries with one id",
    () => edit(list(), (draft) => void draft.data.push({ ...draft.data[0] })),
    "/data/1/id",
  ],
  [
    "limit_exceeded",
    "seven actions",
    () =>
      edit(list(), (draft) => void (draft.actions = Array.from({ length: 7 }, () => noteAction()))),
    "/actions",
  ],
  [
    "unknown_template",
    "a dashboard template",
    () => ({ ...list(), template: "dashboard" }),
    "/template",
  ],
  [
    "unknown_slot",
    "a footer slot",
    () => edit(list(), (draft) => void (draft.slots.footer = [])),
    "/slots/footer",
  ],
  [
    "slot_count",
    "an empty body",
    () => edit(list(), (draft) => void (draft.slots.body = [])),
    "/slots/body",
  ],
  [
    "unknown_component",
    "an approve component",
    () => edit(list(), (draft) => void (draft.slots.body[0].kind = "approve")),
    "/slots/body/0/kind",
  ],
  [
    "component_not_allowed_in_slot",
    "text in a list body",
    () =>
      edit(list(), (draft) => void (draft.slots.body[0] = { kind: "text", words: "Stuck jobs." })),
    "/slots/body/0/kind",
  ],
  ["literal_empty", "a blank title", () => ({ ...list(), title: "   " }), "/title"],
  [
    "literal_too_long",
    "an eighty-one character title",
    () => ({ ...list(), title: "j".repeat(81) }),
    "/title",
  ],
  [
    "literal_has_digits",
    "a count in the title",
    () => ({ ...list(), title: "The 3 stuck jobs" }),
    "/title",
  ],
  [
    "literal_has_currency",
    "a dollar sign",
    () => ({ ...list(), title: "Jobs over the $ budget" }),
    "/title",
  ],
  [
    "literal_has_url",
    "an address in words",
    () =>
      edit(
        list(),
        (draft) => void (draft.slots.side[0].words = "Read more at www.example.invalid"),
      ),
    "/slots/side/0/words",
  ],
  [
    "literal_has_markup",
    "markup in the title",
    () => ({ ...list(), title: "<b>Stuck jobs</b>" }),
    "/title",
  ],
  [
    "literal_bad_character",
    "a direction override",
    () => ({ ...list(), title: "Jobs that are ‮stuck" }),
    "/title",
  ],
  [
    "literal_banned_term",
    "the Assistant",
    () =>
      edit(list(), (draft) => void (draft.slots.side[0].words = "The Assistant found these jobs.")),
    "/slots/side/0/words",
  ],
  [
    "literal_delegation_words",
    "a delegation chip in words",
    () =>
      edit(
        list(),
        (draft) => void (draft.slots.side[0].words = "Releasing a stop is people only."),
      ),
    "/slots/side/0/words",
  ],
  [
    "control_label_not_verb_object",
    "a link labelled Open",
    () => edit(list(), (draft) => void (draft.links[0].label = "Open")),
    "/links/0/label",
  ],
  [
    "control_label_decision_verb",
    "a link that approves",
    () => edit(list(), (draft) => void (draft.links[0].label = "Approve the stuck jobs")),
    "/links/0/label",
  ],
  [
    "decision_link_not_review",
    "a decision link without Review",
    () =>
      edit(list(), (draft) => {
        draft.links[0] = {
          surface: "decision",
          id: "decision-example-0001",
          label: "See the work stop",
          primary: false,
        };
      }),
    "/links/0/label",
  ],
  [
    "receipt_link_not_see_receipt",
    "a receipt link in the retired words",
    () =>
      edit(list(), (draft) => {
        draft.links[0] = {
          surface: "receipt",
          id: "step-example-0001",
          label: "See what it did",
          primary: false,
        };
      }),
    "/links/0/label",
  ],
  [
    "unknown_read_model",
    "a read model nobody serves",
    () => edit(list(), (draft) => void (draft.data[0].read_model = "ledger")),
    "/data/0/read_model",
  ],
  [
    "read_model_unavailable",
    "a job record before the Worker serves it",
    () => ({ spec: example("record_job"), registry: READ_MODELS }),
    "/data/0/read_model",
  ],
  [
    "bad_params",
    "a section that is not a token",
    () => edit(list(), (draft) => void (draft.data[0].params.section = "Cannot Start!")),
    "/data/0/params/section",
  ],
  [
    "unbound_binding",
    "a binding to an undeclared entry",
    () => edit(list(), (draft) => void (draft.slots.status[0].counts[0].value.bind = "ghost")),
    "/slots/status/0/counts/0/value/bind",
  ],
  [
    "bad_path",
    "a path that is not a pointer",
    () => edit(list(), (draft) => void (draft.slots.body[0].rows.path = "items")),
    "/slots/body/0/rows/path",
  ],
  [
    "unknown_field_path",
    "a field the read model does not publish",
    () => edit(list(), (draft) => void (draft.slots.body[0].title.field = "secret")),
    "/slots/body/0/title/field",
  ],
  [
    "field_type_mismatch",
    "a text field where a state goes",
    () => edit(list(), (draft) => void (draft.slots.body[0].state.field = "job_name")),
    "/slots/body/0/state/field",
  ],
  [
    "missing_sources",
    "a data entry citing nothing",
    () => edit(list(), (draft) => void (draft.data[0].sources = [])),
    "/data/0/sources",
  ],
  [
    "bad_source",
    "a short hash",
    () => edit(list(), (draft) => void (draft.data[0].sources[0].hash = "sha256:abc")),
    "/data/0/sources/0/hash",
  ],
  [
    "unknown_specialist",
    "a specialist nobody hired",
    () => ({ ...list(), specialist_id: "ghost" }),
    "/specialist_id",
  ],
  [
    "specialist_not_face",
    "a view from the AI estimator",
    () => ({ ...list(), specialist_id: "estimator" }),
    "/specialist_id",
  ],
  [
    "catalog_mismatch",
    "another catalog",
    () => ({ ...list(), catalog_sha256: `sha256:${"0".repeat(64)}` }),
    "/catalog_sha256",
  ],
  [
    "unknown_action",
    "an action the catalog lacks",
    () =>
      edit(
        list(),
        (draft) => void (draft.actions = [{ ...noteAction(), action_id: "approval.grant" }]),
      ),
    "/actions/0/action_id",
  ],
  [
    "action_not_owned",
    "an action no specialist owns",
    () => ({
      spec: edit(list(), (draft) => {
        draft.actions = [{ ...noteAction(), action_id: "note.orphan" }];
        draft.catalog_sha256 = `sha256:${"b".repeat(64)}`;
      }),
      catalog: {
        ...catalog,
        sha256: "b".repeat(64),
        actions: [
          ...catalog.actions,
          { ...catalogAction("note.add"), action_id: "note.orphan", owners: [] },
        ],
      },
    }),
    "/actions/0/action_id",
  ],
  [
    "action_people_only",
    "a refund",
    () =>
      edit(
        list(),
        (draft) =>
          void (draft.actions = [{ ...noteAction("Issue the refund"), action_id: "refund.issue" }]),
      ),
    "/actions/0/action_id",
  ],
  [
    "action_read_only",
    "an explanation offered as a button",
    () =>
      edit(
        list(),
        (draft) =>
          void (draft.actions = [
            { ...noteAction("Explain the stuck jobs"), action_id: "fact.explain" },
          ]),
      ),
    "/actions/0/action_id",
  ],
  [
    "action_outside_effect",
    "a request for prices sent to suppliers",
    () =>
      edit(
        list(),
        (draft) =>
          void (draft.actions = [
            { ...noteAction("Send the price request"), action_id: "rfq.send" },
          ]),
      ),
    "/actions/0/action_id",
  ],
  [
    "action_owner_control",
    "a hold on a specialist",
    () =>
      edit(
        list(),
        (draft) =>
          void (draft.actions = [
            { ...noteAction("Hold the AI estimator"), action_id: "specialist.hold" },
          ]),
      ),
    "/actions/0/action_id",
  ],
  [
    "action_run_only",
    "an escalation a person would press",
    () =>
      edit(
        list(),
        (draft) =>
          void (draft.actions = [
            { ...noteAction("Escalate the job to Tom"), action_id: "exception.escalate" },
          ]),
      ),
    "/actions/0/action_id",
  ],
  [
    "action_asks_first_not_offered_as_request",
    "an A3 action labelled to act",
    () =>
      edit(
        example("schedule_crews_this_week"),
        (draft) => void (draft.actions[0].label = "Commit a start date"),
      ),
    "/actions/0/label",
  ],
  [
    "action_label_promises_approval",
    "an A2 action labelled as a request",
    () =>
      edit(list(), (draft) => {
        draft.actions = [
          { ...noteAction("Prepare a pause for your approval"), action_id: "followup.pause" },
        ];
      }),
    "/actions/0/label",
  ],
  [
    "action_target_unbound",
    "a target on a text field",
    () =>
      edit(
        example("schedule_crews_this_week"),
        (draft) => void (draft.actions[0].target.path = "/unscheduled/*/job_name"),
      ),
    "/actions/0/target",
  ],
  [
    "unknown_surface",
    "an admin surface",
    () => edit(list(), (draft) => void (draft.links[0].surface = "admin")),
    "/links/0/surface",
  ],
  [
    "bad_link_id",
    "an id on Now",
    () => edit(list(), (draft) => void (draft.links[0].id = "now-1")),
    "/links/0/id",
  ],
  [
    "bad_index",
    "an empty hint pointing past the links",
    () => edit(list(), (draft) => void (draft.slots.empty[0].link = 4)),
    "/slots/empty/0/link",
  ],
  [
    "two_next_steps",
    "an empty hint with a link and an action",
    () =>
      edit(list(), (draft) => {
        draft.actions = [noteAction()];
        draft.slots.empty[0].action = 0;
      }),
    "/slots/empty/0",
  ],
  [
    "primary_count",
    "a second primary",
    () => edit(list(), (draft) => void (draft.links[0].primary = true)),
    "/links/0/primary",
  ],
  [
    "chart_without_table",
    "a chart without its table",
    () =>
      edit(example("report_margin_watch"), (draft) => {
        draft.slots.body[1] = {
          kind: "chart",
          heading: "Cost so far by job",
          chart_kind: "bar",
          series: [
            {
              label: "Cost so far",
              points: { bind: "margins", path: "/jobs" },
              x: { field: "job" },
              y: { field: "cost_so_far" },
            },
          ],
        };
      }),
    "/slots/body/1/series/0",
  ],
  [
    "total_not_a_column",
    "a total of a column the table lacks",
    () =>
      edit(
        example("report_margin_watch"),
        (draft) => void (draft.slots.body[1].total = ["Profit"]),
      ),
    "/slots/body/1/total/0",
  ],
  [
    "versus_not_a_criterion",
    "a difference on a row the comparison does not show",
    () =>
      edit(example("comparison_panels"), (draft) => {
        draft.slots.body[0].criteria = draft.slots.body[0].criteria.filter(
          (row: Spec) => row.field.field !== "landed_cost",
        );
      }),
    "/slots/body/0/versus",
  ],
  ["place_not_allowed", "a customer page", () => list(), "", "customer"],
];

function catalogAction(id: string) {
  const found = catalog.actions.find((action) => action.action_id === id);
  if (!found) throw new Error(`no ${id} in the catalog`);
  return found;
}

/** A case returns a spec, or a spec with the registry or catalog it must be checked against. */
function issuesFor(input: unknown, place: Place = "office"): ViewSpecIssue[] {
  if (typeof input === "object" && input !== null && "spec" in input) {
    const {
      spec,
      registry,
      catalog: against,
    } = input as {
      spec: unknown;
      registry?: ReadModelRegistry;
      catalog?: ViewSpecCatalog;
    };
    const result = run(spec, place, registry ?? ALL, against ?? catalog);
    return result.ok ? [] : [...result.issues];
  }
  return issuesOf(input, place);
}

describe("one failing spec per issue code", () => {
  it("has a case for every code", () => {
    expect(new Set(CASES.map(([code]) => code))).toEqual(new Set(VIEW_SPEC_ISSUE_CODES));
  });

  it.each(CASES)("%s: %s", (code, _what, build, path, place) => {
    const issues = issuesFor(build(), place);
    expect(issues).toContainEqual(expect.objectContaining({ code, path }));
    for (const found of issues) expect(VIEW_SPEC_ISSUE_CODES).toContain(found.code);
  });
});

describe("collecting every issue", () => {
  it("reports problems in the title, data, actions, links and slots of one spec at once", () => {
    const spec = edit(list(), (draft) => {
      draft.title = "Jobs stuck since 2 weeks";
      draft.data[0].read_model = "ledger";
      draft.actions = [{ ...noteAction(), action_id: "approval.grant" }];
      draft.links[0].surface = "admin";
      draft.slots.side[0].words = "The Assistant made this.";
      draft.slots.body[0].kind = "approve";
    });
    const issues = issuesOf(spec);
    const codes = issues.map((found) => found.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "literal_has_digits",
        "unknown_read_model",
        "unknown_action",
        "unknown_surface",
        "literal_banned_term",
        "unknown_component",
      ]),
    );
    expect(issues.every((found) => typeof found.detail === "string" && found.detail !== "")).toBe(
      true,
    );
  });

  it("refuses size, depth and JSON problems with that one issue", () => {
    const huge = JSON.stringify({ ...list(), title: "a".repeat(70_000), spec_id: 7 });
    const deep = { ...list(), spec_id: 7, slots: { body: [[[[[[["x"]]]]]]] } };
    for (const [input, code] of [
      ["{", "not_json"],
      [huge, "too_large"],
      [deep, "too_deep"],
      [{ ...list(), spec_id: 7, title: undefined }, "not_json"],
    ] as const) {
      expect(issuesOf(input)).toEqual([expect.objectContaining({ code, path: "" })]);
    }
  });
});

describe("adversarial specs are refused without throwing", () => {
  const nested = (depth: number): unknown => (depth === 0 ? "x" : [nested(depth - 1)]);
  const cyclic: Record<string, unknown> = { ...list() };
  cyclic.self = cyclic;
  class Holder {
    title = "Jobs";
  }
  const withGetter = Object.defineProperty({ ...list() }, "title", {
    enumerable: true,
    get() {
      throw new Error("read");
    },
  });

  const ADVERSARIAL: [string, () => unknown, ViewSpecIssueCode][] = [
    [
      "a script tag in the title",
      () => ({ ...list(), title: "<script>alert</script>" }),
      "literal_has_markup",
    ],
    [
      "HTML in a paragraph",
      () =>
        edit(
          list(),
          (draft) => void (draft.slots.side[0].words = 'Stuck <img src="x" onerror="go">'),
        ),
      "literal_has_markup",
    ],
    [
      "a javascript: link in an empty hint",
      () => edit(list(), (draft) => void (draft.slots.empty[0].words = "Try javascript:alert")),
      "literal_has_url",
    ],
    [
      "a url prop",
      () => edit(list(), (draft) => void (draft.slots.body[0].url = "https://example.invalid")),
      "unknown_key",
    ],
    [
      "an href on a link",
      () => edit(list(), (draft) => void (draft.links[0].href = "/admin")),
      "unknown_key",
    ],
    [
      "a className prop",
      () => edit(list(), (draft) => void (draft.slots.side[0].className = "red")),
      "unknown_key",
    ],
    [
      "an approve component",
      () => edit(list(), (draft) => void (draft.slots.body[0].kind = "approve")),
      "unknown_component",
    ],
    [
      "a people-only action",
      () =>
        edit(
          list(),
          (draft) =>
            void (draft.actions = [
              { ...noteAction("Release the safety stop"), action_id: "safety_stop.release" },
            ]),
        ),
      "action_people_only",
    ],
    [
      "an A3 action asking to act",
      () =>
        edit(
          example("schedule_crews_this_week"),
          (draft) => void (draft.actions[0].label = "Set the start date"),
        ),
      "action_asks_first_not_offered_as_request",
    ],
    [
      "a request field on an action",
      () =>
        edit(
          example("schedule_crews_this_week"),
          (draft) => void (draft.actions[0].request = "act"),
        ),
      "unknown_key",
    ],
    [
      "an action the catalog lacks",
      () =>
        edit(
          list(),
          (draft) => void (draft.actions = [{ ...noteAction(), action_id: "payment.send_now" }]),
        ),
      "unknown_action",
    ],
    [
      "a binding to an undeclared data id",
      () => edit(list(), (draft) => void (draft.slots.body[0].rows.bind = "elsewhere")),
      "unbound_binding",
    ],
    [
      "a path the read model does not publish",
      () => edit(list(), (draft) => void (draft.slots.body[0].rows.path = "/customers")),
      "unknown_field_path",
    ],
    [
      "a money prop bound to a text field",
      () =>
        edit(
          example("comparison_panels"),
          (draft) => void (draft.slots.body[0].versus.field = "supplier_name"),
        ),
      "field_type_mismatch",
    ],
    [
      "a bound control label that reads a proposal, not words",
      () =>
        edit(
          example("report_margin_watch"),
          (draft) => void (draft.actions[0].label.path = "/items/0/proposal"),
        ),
      "field_type_mismatch",
    ],
    [
      "an action target bound to words",
      () =>
        edit(
          example("report_margin_watch"),
          (draft) => void (draft.actions[0].target.path = "/items/0/proposal/notify_label"),
        ),
      "action_target_unbound",
    ],
    [
      "a source with a bad hash",
      () => edit(list(), (draft) => void (draft.data[0].sources[1].hash = `md5:${"a".repeat(32)}`)),
      "bad_source",
    ],
    ["digits in a title", () => ({ ...list(), title: "Top 10 stuck jobs" }), "literal_has_digits"],
    [
      'the word "Assistant" in a label',
      () => edit(list(), (draft) => void (draft.links[0].label = "Ask the Assistant")),
      "literal_banned_term",
    ],
    [
      "an AI name that is not in the contract",
      () => edit(list(), (draft) => void (draft.slots.side[0].words = "AI helper found these.")),
      "literal_banned_term",
    ],
    ["a 70 KB spec as a value", () => ({ ...list(), title: "a".repeat(70_000) }), "too_large"],
    ["depth 20", () => ({ ...list(), slots: { body: [nested(20)] } }), "too_deep"],
    ["a cycle", () => cyclic, "too_deep"],
    ["a class instance", () => ({ ...list(), title: new Holder() }), "not_json"],
    ["a getter", () => withGetter, "not_json"],
    ["undefined", () => undefined, "not_json"],
    ["a big integer", () => ({ ...list(), title: BigInt(1) }), "not_json"],
    ["not a number", () => ({ ...list(), title: Number.NaN }), "not_json"],
    ["an array", () => ["a view"], "wrong_type"],
    [
      "__proto__ and constructor keys",
      () =>
        JSON.parse(
          JSON.stringify(list()).replace(
            '"title":',
            '"__proto__":{"polluted":true},"constructor":{"x":1},"title":',
          ),
        ),
      "unknown_key",
    ],
    ["a constructor template", () => ({ ...list(), template: "constructor" }), "unknown_template"],
    [
      "a __proto__ component",
      () => edit(list(), (draft) => void (draft.slots.body[0].kind = "__proto__")),
      "unknown_component",
    ],
    [
      "a toString read model",
      () => edit(list(), (draft) => void (draft.data[0].read_model = "toString")),
      "unknown_read_model",
    ],
    [
      "a hasOwnProperty surface",
      () => edit(list(), (draft) => void (draft.links[0].surface = "hasOwnProperty")),
      "unknown_surface",
    ],
    [
      "a constructor slot",
      () => edit(list(), (draft) => void (draft.slots.constructor = [])),
      "unknown_slot",
    ],
    [
      "a __proto__ binding",
      () => edit(list(), (draft) => void (draft.slots.body[0].rows.bind = "__proto__")),
      "unbound_binding",
    ],
    [
      "a __proto__ row field",
      () => edit(list(), (draft) => void (draft.slots.body[0].title.field = "__proto__")),
      "unknown_field_path",
    ],
    [
      "a valueOf param",
      () => edit(list(), (draft) => void (draft.data[0].params.valueOf = "x")),
      "bad_params",
    ],
    [
      "a proxy whose traps throw",
      () =>
        new Proxy(list(), {
          ownKeys() {
            throw new Error("trap");
          },
        }),
      "not_json",
    ],
    [
      "a soft hyphen inside a banned word",
      () => ({ ...list(), title: "Assis­tant found these" }),
      "literal_bad_character",
    ],
    [
      "fullwidth letters",
      () => ({ ...list(), title: "Ａｓｓｉｓｔａｎｔ" }),
      "literal_bad_character",
    ],
    ["a filler that looks blank", () => ({ ...list(), title: "ㅤ" }), "literal_bad_character"],
    ["another script", () => ({ ...list(), title: "\u0410ssistant" }), "literal_bad_character"],
    ["an emoji", () => ({ ...list(), title: "Stuck jobs \u{1F6A8}" }), "literal_bad_character"],
    [
      "a domain outside a short list",
      () => edit(list(), (draft) => void (draft.slots.side[0].words = "Pay now at pay-now.xyz")),
      "literal_has_url",
    ],
    [
      "an address with an at sign",
      () => edit(list(), (draft) => void (draft.slots.side[0].words = "Write to help@evil.ru")),
      "literal_bad_character",
    ],
    [
      "a review link that also approves",
      () =>
        edit(list(), (draft) => {
          draft.links[0] = {
            surface: "decision",
            id: "decision-example-0001",
            label: "Review and approve the work stop",
            primary: false,
          };
        }),
      "control_label_decision_verb",
    ],
    [
      "the search query echoed as a fact",
      () =>
        edit(servedList(), (draft) => {
          draft.data.push({
            id: "found",
            read_model: "search",
            params: { q: "call now" },
            sources: [SOURCE],
          });
          draft.slots.side = [
            {
              kind: "key_values",
              heading: null,
              rows: [{ label: "Asked for", value: { bind: "found", path: "/query" } }],
            },
          ];
        }),
      "unknown_field_path",
    ],
    ["a sparse array", () => ({ ...list(), actions: new Array(3) }), "not_json"],
    [
      "a sparse array four billion long",
      () => ({ ...list(), actions: new Array(2 ** 32 - 1) }),
      "too_large",
    ],
    [
      "one long string shared many times",
      () => ({ ...list(), links: Array.from({ length: 40 }, () => "x".repeat(20_000)) }),
      "too_large",
    ],
    [
      "a total twice",
      () =>
        edit(
          example("report_margin_watch"),
          (draft) => void (draft.slots.body[1].total = ["Estimated cost", "Estimated cost"]),
        ),
      "wrong_type",
    ],
    // A decision verb anywhere in a control label, as a whole word and in its other forms.
    ...[
      "Now approve the quote",
      "Quickly approve the quote",
      "Please approve the quote",
      "Pause to approve the quote",
      "Pause. Approve the quote",
      "Pause; approve the quote",
      "Authorize the payment",
      "Authorise the payment",
      "Confirm the quote",
      "Countersign the contract",
      "See the approved quotes",
      "Keep accepting the quote",
      "Pay the supplier",
      "Show what was paid",
      "Mark the deposit refunded",
      "Write off the balance",
      "Show what was written off",
      "Hold the signed contract",
      "Preapprove the quote",
      "Reconfirm the visit",
      "Apply the payment",
      "Cosign the contract",
    ].map((label): [string, () => unknown, ViewSpecIssueCode] => [
      `the control label "${label}"`,
      () =>
        edit(list(), (draft) => {
          draft.actions = [{ ...noteAction(label), action_id: "followup.pause" }];
        }),
      "control_label_decision_verb",
    ]),
    [
      "a review that also approves",
      () => edit(list(), (draft) => void (draft.links[0].label = "Review and approve the quote")),
      "control_label_decision_verb",
    ],
    ["a thorn", () => ({ ...list(), title: "Jobs to a\u00FE\u00FEly" }), "literal_bad_character"],
    ["an eng", () => ({ ...list(), title: "Decli\u014Be notes" }), "literal_bad_character"],
    [
      "a link that approves quickly",
      () => edit(list(), (draft) => void (draft.links[0].label = "Quickly approve all")),
      "control_label_decision_verb",
    ],
    // Letters outside ASCII, Latin-1 and Latin Extended-A, which can pass for others.
    [
      "a digit lookalike",
      () => ({ ...list(), title: "Jobs stuck \u01A7" }),
      "literal_bad_character",
    ],
    ["a Latin alpha", () => ({ ...list(), title: "\u0251gent notes" }), "literal_bad_character"],
    [
      "a small capital",
      () => ({ ...list(), title: "\u1D21\u1D0F\u0280\u1D0B\u1D07\u0280 jobs" }),
      "literal_bad_character",
    ],
    ["a script g", () => ({ ...list(), title: "\u0261rant the access" }), "literal_bad_character"],
    [
      "an alpha in a control label",
      () =>
        edit(list(), (draft) => {
          draft.actions = [
            { ...noteAction("\u0251pprove the quote"), action_id: "followup.pause" },
          ];
        }),
      "literal_bad_character",
    ],
    // Allowed accented letters are folded before the word rules read them.
    [
      "an accented decision verb",
      () =>
        edit(list(), (draft) => {
          draft.actions = [
            { ...noteAction("\u00C0pprove the quote"), action_id: "followup.pause" },
          ];
        }),
      "control_label_decision_verb",
    ],
    [
      "a dotless i in a banned word",
      () => ({ ...list(), title: "Ass\u0131stant found these" }),
      "literal_banned_term",
    ],
    // Text that is not well-formed, anywhere in the document.
    ["a lone surrogate in a title", () => ({ ...list(), title: "Stuck \ud800 jobs" }), "not_json"],
    [
      "a lone surrogate in a param",
      () =>
        edit(
          servedList(),
          (draft) =>
            void draft.data.push({
              id: "found",
              read_model: "search",
              params: { q: "ab\ud83dcd" },
              sources: [SOURCE],
            }),
        ),
      "not_json",
    ],
    ["a lone surrogate in a key", () => JSON.parse('{"\\udc00":1}'), "not_json"],
    // Numbers and money in words, and the AI spelled with points or a space.
    [
      "twelve thousand dollars",
      () => ({ ...list(), title: "Twelve thousand dollars at risk" }),
      "literal_has_number_words",
    ],
    [
      "twenty percent",
      () => ({ ...list(), title: "Twenty percent over" }),
      "literal_has_number_words",
    ],
    ["half", () => ({ ...list(), title: "Half the jobs are late" }), "literal_has_number_words"],
    ["a dozen", () => ({ ...list(), title: "A dozen jobs wait" }), "literal_has_number_words"],
    ["a currency code", () => ({ ...list(), title: "Totals in CAD" }), "literal_has_number_words"],
    ["cents", () => ({ ...list(), title: "Every cent is in" }), "literal_has_number_words"],
    ["A.I.", () => ({ ...list(), title: "A.I. helper found these" }), "literal_banned_term"],
    ["A I", () => ({ ...list(), title: "The A I helper found these" }), "literal_banned_term"],
  ];

  it.each(ADVERSARIAL)("%s", (_what, build, code) => {
    let issues: ViewSpecIssue[] = [];
    expect(() => {
      issues = issuesOf(build());
    }).not.toThrow();
    expect(issues.map((found) => found.code)).toContain(code);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps the registries frozen", () => {
    expect(Object.isFrozen(READ_MODELS)).toBe(true);
    expect(Object.isFrozen(READ_MODELS.owner_now?.fields)).toBe(true);
    expect(Object.isFrozen(TEMPLATES.list.slots.body)).toBe(true);
    expect(Object.isFrozen(COMPONENTS.list)).toBe(true);
  });

  it("reads only the start of an over-long literal, so near-limit specs stay fast", () => {
    for (const long of ["a-".repeat(29_000), "a.".repeat(29_000), "AI team ".repeat(7_000)]) {
      const spec = edit(list(), (draft) => {
        draft.title = long.slice(0, 20_000);
        draft.links[0].label = long.slice(0, 20_000);
        draft.slots.side[0].words = long.slice(0, 20_000);
      });
      const started = performance.now();
      const codes = issuesOf(spec).map((found) => found.code);
      expect(performance.now() - started).toBeLessThan(250);
      expect(codes).toContain("literal_too_long");
    }
  });

  it("returns a frozen copy, so changing the input later changes nothing that was checked", () => {
    const input = list();
    const result = run(input);
    input.title = "<script>changed</script>";
    expect(result.ok && result.spec.title).toBe("Jobs that are stuck");
    expect(result.ok && Object.isFrozen(result.spec.slots.body)).toBe(true);
  });
});

describe("places", () => {
  it("draws nothing generated on customer pages or the shop tablet", () => {
    for (const place of ["customer", "glove"] as const) {
      expect(issuesOf(list(), place)).toContainEqual(
        expect.objectContaining({ code: "place_not_allowed", path: "" }),
      );
    }
  });

  it("keeps the crew phone to read-only records, timelines and schedules without money", () => {
    const at = (spec: Spec) =>
      issuesOf(spec, "crew")
        .filter((found) => found.code === "place_not_allowed")
        .map((found) => found.path);
    expect(at(list())).toContain("/template");
    expect(at(edit(servedCrewRecord(), (draft) => void (draft.actions = [noteAction()])))).toEqual([
      "/actions/0",
    ]);
    expect(
      at(edit(servedCrewRecord(), (draft) => void (draft.links[0].surface = "decisions"))),
    ).toEqual(["/links/0/surface"]);
    // Receipts, the decision link, money, approvals and the office links; nothing else.
    expect(at(example("record_job"))).toEqual([
      "/links/0/surface",
      "/links/1/surface",
      "/slots/body/0/receipts/path",
      "/slots/body/1/link/field",
      "/slots/body/2/columns/2/field/field",
      "/slots/side/0/approvals/path",
    ]);
    // The action, the manual link, the record links of blocks and rows, and the decisions.
    expect(at(example("schedule_crews_this_week"))).toEqual([
      "/actions/0",
      "/links/0/surface",
      "/slots/body/0/link/field",
      "/slots/body/1/link/field",
      "/slots/side/0/decisions/path",
    ]);
  });

  it("refuses one value taken from decisions or approvals on the crew phone", () => {
    const spec = edit(servedCrewRecord(), (draft) => {
      draft.data.push(
        {
          id: "dec",
          read_model: "decisions",
          params: { job: "job-example-0001" },
          sources: [SOURCE],
        },
        {
          id: "app",
          read_model: "approvals",
          params: { job: "job-example-0001" },
          sources: [SOURCE],
        },
      );
      draft.slots.side = [
        {
          kind: "key_values",
          heading: null,
          rows: [
            { label: "Waiting on", value: { bind: "dec", path: "/items/0/waiting_on" } },
            { label: "Decision", value: { bind: "dec", path: "/items/0/title" } },
            { label: "Approved by", value: { bind: "app", path: "/items/0/approved_by" } },
            { label: "What they saw", value: { bind: "app", path: "/items/0/what_they_saw" } },
          ],
        },
      ];
    });
    expect(run(spec, "office").ok).toBe(true);
    expect(
      issuesOf(spec, "crew")
        .filter((found) => found.code === "place_not_allowed")
        .map((found) => found.path),
    ).toEqual([0, 1, 2, 3].map((row) => `/slots/side/0/rows/${row}/value/path`));
  });

  it("links the crew phone only to its own Now", () => {
    const linkTo = (surface: string, id: unknown) =>
      edit(servedCrewRecord(), (draft) => {
        draft.links[0] = { surface, id, label: "See the record", primary: false };
      });
    expect(issuesOf(servedCrewRecord(), "crew", READ_MODELS)).toEqual([]);
    for (const [surface, id] of [
      ["receipt", "step-example-0001"],
      ["job_record", "job-example-0001"],
    ] as const) {
      expect(issuesOf(linkTo(surface, id), "crew")).toContainEqual(
        expect.objectContaining({ code: "place_not_allowed", path: "/links/0/surface" }),
      );
    }
    const receiptRows = edit(servedCrewRecord(), (draft) => {
      draft.data[0].params.page_size = 10;
      draft.slots.body[0].items.path = "/items";
      Object.assign(draft.slots.body[0], {
        when: { field: "when" },
        actor: { field: "actor" },
        what: { field: "what" },
        detail: null,
        link: { field: "receipt_link" },
      });
    });
    expect(issuesOf(receiptRows, "office")).toEqual([]);
    expect(issuesOf(receiptRows, "crew")).toContainEqual(
      expect.objectContaining({ code: "place_not_allowed", path: "/slots/body/0/link/field" }),
    );
  });

  it("refuses approvals, decisions and receipts on the crew phone in any component", () => {
    const spec = edit(servedCrewRecord(), (draft) => {
      draft.data.push({
        id: "ap",
        read_model: "approvals",
        params: { job: "job-example-0001" },
        sources: [SOURCE],
      });
      draft.slots.side = [
        {
          kind: "list",
          heading: "Who approved this",
          rows: { bind: "ap", path: "/items" },
          title: { field: "thing" },
          meta: [{ field: "what_they_saw" }],
          state: null,
          proposed: null,
          link: null,
          primary: false,
        },
      ];
    });
    expect(run(spec, "office").ok).toBe(true);
    expect(issuesOf(spec, "crew").filter((found) => found.code === "place_not_allowed")).toEqual([
      expect.objectContaining({ path: "/slots/side/0/rows/path" }),
    ]);
  });
});

describe("callers", () => {
  it("fails closed without a place, and without a catalog", () => {
    const noPlace = validateViewSpec(list(), catalog, {} as unknown as { place: Place });
    expect(noPlace.ok || noPlace.issues).toContainEqual(
      expect.objectContaining({ code: "place_not_allowed", path: "" }),
    );
    let codes: string[] = [];
    expect(() => {
      const result = validateViewSpec(list(), null as unknown as ViewSpecCatalog, {
        place: "office",
      });
      codes = result.ok ? [] : result.issues.map((found) => found.code);
    }).not.toThrow();
    expect(codes).toEqual(expect.arrayContaining(["catalog_mismatch", "unknown_specialist"]));
  });

  it("fails closed on a catalog without its hash, even when the spec names none", () => {
    const noHash = { actions: catalog.actions, specialists: catalog.specialists };
    const result = validateViewSpec(
      { ...list(), catalog_sha256: null },
      noHash as unknown as ViewSpecCatalog,
      { place: "office" },
    );
    expect(result.ok).toBe(false);
    expect(result.ok || result.issues).toContainEqual(
      expect.objectContaining({ code: "catalog_mismatch", path: "/catalog_sha256" }),
    );
    expect(issuesOf({ ...list(), catalog_sha256: null })).toContainEqual(
      expect.objectContaining({ code: "catalog_mismatch", path: "/catalog_sha256" }),
    );
  });

  it("fails closed, without throwing, on a hand-built catalog or registry that is malformed", () => {
    const withAction = (action: object) =>
      ({ ...catalog, actions: [...catalog.actions, action] }) as unknown as ViewSpecCatalog;
    const spec = edit(
      list(),
      (draft) => void (draft.actions = [{ ...noteAction(), action_id: "note.loose" }]),
    );
    for (const loose of [
      { action_id: "note.loose" },
      { action_id: "note.loose", owners: ["estimator"] },
    ]) {
      let result: ReturnType<typeof validateViewSpec> | undefined;
      expect(() => {
        result = validateViewSpec(spec, withAction(loose), { place: "office", readModels: ALL });
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      expect(result?.ok || result?.issues).toContainEqual(
        expect.objectContaining({ code: "catalog_mismatch", path: "/catalog_sha256" }),
      );
    }
    const registry = { ...ALL, owner_now: { available: true, path: "/api/v1/owner/now" } };
    let codes: string[] = [];
    expect(() => {
      const result = validateViewSpec(list(), catalog, {
        place: "office",
        readModels: registry as unknown as ReadModelRegistry,
      });
      codes = result.ok ? [] : result.issues.map((found) => found.code);
    }).not.toThrow();
    expect(codes).toContain("unknown_read_model");
  });

  it("keeps a catalog action without its class, but never offers it", () => {
    const parsed = JSON.parse(CATALOG_JSON) as { actions: Record<string, unknown>[] };
    delete parsed.actions[0]?.autonomy;
    const built = catalogFromContractJson(JSON.stringify(parsed), CATALOG_SHA256);
    expect(built.actions[0]?.recognized).toBe(false);
    expect(actionRequestKind(built.actions[0]!)).toBeNull();
  });

  it("cites at most as many facts, and as long, as the Worker's run and receipt paths take", () => {
    const sources = (count: number, length = 20) =>
      edit(list(), (draft) => {
        draft.data[0].sources = Array.from({ length: count }, (_, index) => ({
          ...SOURCE,
          fact_id: `job/${"x".repeat(length - 6)}${String(index).padStart(2, "0")}`,
        }));
      });
    expect(issuesOf(sources(40))).toEqual([]);
    expect(issuesOf(sources(41))).toContainEqual(
      expect.objectContaining({ code: "limit_exceeded", path: "/data/0/sources" }),
    );
    expect(issuesOf(sources(1, 160))).toEqual([]);
    expect(issuesOf(sources(1, 161))).toContainEqual(
      expect.objectContaining({ code: "bad_source", path: "/data/0/sources/0/fact_id" }),
    );
  });

  it("accepts accented Latin letters in literal words", () => {
    expect(issuesOf({ ...list(), title: "Résumé of the crew's notes" })).toEqual([]);
  });
});

describe("actions", () => {
  it("offers A1 and A2 work as acts, A3 as a request, and nothing people only", () => {
    expect(actionRequestKind(catalogAction("quote.draft_revision"))).toBe("act");
    expect(actionRequestKind(catalogAction("followup.pause"))).toBe("act");
    expect(actionRequestKind(catalogAction("crew_date.commit"))).toBe("prepare_for_approval");
    expect(actionRequestKind(catalogAction("purchase_order.place"))).toBe("prepare_for_approval");
    expect(actionRequestKind(catalogAction("refund.issue"))).toBeNull();
    expect(actionRequestKind(catalogAction("fact.explain"))).toBeNull();
    expect(actionRequestKind(catalogAction("rfq.send"))).toBeNull();
  });

  it("accepts a protective action offered as an act", () => {
    const spec = edit(list(), (draft) => {
      draft.actions = [
        {
          ...noteAction("Hand the conversation to a person"),
          action_id: "conversation.assign_person",
        },
      ];
    });
    expect(issuesOf(spec)).toEqual([]);
  });

  it("totals only money, counts and measures", () => {
    const spec = edit(
      example("report_margin_watch"),
      (draft) => void (draft.slots.body[1].total = ["Margin"]),
    );
    expect(issuesOf(spec)).toContainEqual(
      expect.objectContaining({ code: "field_type_mismatch", path: "/slots/body/1/total/0" }),
    );
  });
});

describe("JSON Schema export", () => {
  it("lists only the read models the Worker serves and only the actions a view may offer", () => {
    const schema = viewSpecJsonSchema({ catalog }) as Spec;
    const data = schema.properties.data.items.properties;
    expect(new Set(data.read_model.enum)).toEqual(
      new Set(
        Object.entries(READ_MODELS)
          .filter(([, model]) => model.available)
          .map(([name]) => name),
      ),
    );
    const offered: string[] = schema.properties.actions.items.properties.action_id.enum;
    for (const action of catalog.actions) {
      expect(offered.includes(action.action_id)).toBe(actionRequestKind(action) !== null);
    }
    expect(schema.properties.catalog_sha256.const).toBe(`sha256:${CATALOG_SHA256}`);
    expect(schema.properties.specialist_id.enum).toEqual(["orchestrator"]);
  });

  it("gives each single-kind slot its kind's exact shape", () => {
    const slots = (viewSpecJsonSchema() as Spec).properties.slots.properties;
    expect(Object.keys(slots.empty.items.properties)).toEqual([
      "kind",
      ...Object.keys(COMPONENTS.empty_hint),
    ]);
    expect(slots.empty.items.properties.kind.const).toBe("empty_hint");
    expect(slots.body.items.properties.rows.type).toEqual(["object", "array", "null"]);
  });
});

describe("registries", () => {
  const descriptors = (model: (typeof READ_MODELS)[string]) =>
    ({ ...model.fields, ...model.planned_fields }) as Record<string, FieldDescriptor>;

  it("declares every row field under a collection and every path param in its route", () => {
    for (const [name, model] of Object.entries(READ_MODELS)) {
      const fields = descriptors(model);
      expect(
        Object.keys(model.fields).filter((path) => path in model.planned_fields),
        name,
      ).toEqual([]);
      for (const path of Object.keys(fields)) {
        expect(path, name).toMatch(/^(?:\/(?:[A-Za-z_][A-Za-z0-9_]*|\*))+$/);
        const parent = path.lastIndexOf("/*/");
        if (parent !== -1) {
          const owner = fields[path.slice(0, parent)];
          expect(typeof owner === "object" && "rows" in owner, `${name} ${path}`).toBe(true);
        }
      }
      expect(model.available ? model.path : "served later", name).not.toBeNull();
      const inPath = [...(model.path ?? "").matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
      const pathParams = Object.entries({ ...model.params, ...model.planned_params })
        .filter(([, def]) => def.in === "path")
        .map(([param]) => param);
      if (model.path) expect(inPath.sort(), name).toEqual(pathParams.sort());
    }
  });

  it("names a collection prop for every row field of every component", () => {
    const check = (
      props: Readonly<Record<string, PropDef>>,
      outer: Readonly<Record<string, PropDef>>,
    ) => {
      for (const [name, def] of Object.entries(props)) {
        if (def.is === "objects") check(def.props, { ...outer, ...props });
        if ((def.is === "field" || def.is === "fields") && def.of !== "@body") {
          const base = props[def.of] ?? outer[def.of];
          expect(base?.is, `${name} of ${def.of}`).toBe("rows");
        }
      }
    };
    for (const props of Object.values(COMPONENTS)) check(props, {});
  });

  it("holds the density limits of TEMPLATES.md 4.5", () => {
    expect(LIMITS).toMatchObject({
      depth: 6,
      charts: 2,
      status_counts: 4,
      filters: 4,
      table_columns: 7,
      key_values_rows: 8,
      comparison_criteria: 12,
      chart_series: 3,
    });
    for (const def of Object.values(TEMPLATES)) {
      expect((def.slots as Record<string, { max: number }>).side?.max ?? 0).toBeLessThanOrEqual(4);
      expect((def.slots as Record<string, { max: number }>).summary?.max ?? 0).toBeLessThanOrEqual(
        4,
      );
    }
  });

  it("gives the renderer plain fallback words", () => {
    expect(viewSpecFallbackWords).toEqual({
      title: "IronWrap couldn't show this.",
      next_step: "Ask another way, or search.",
    });
  });

  it("refuses a malformed catalog", () => {
    expect(() => catalogFromContractJson(CATALOG_JSON, "not-a-sha")).toThrow(TypeError);
    expect(() => catalogFromContractJson("{}", CATALOG_SHA256)).toThrow(TypeError);
    expect(() =>
      catalogFromContractJson(
        JSON.stringify({ specialists: [], actions: [{ action_id: 1 }] }),
        CATALOG_SHA256,
      ),
    ).toThrow(TypeError);
    expect(Object.isFrozen(catalog.actions)).toBe(true);
  });
});

describe("read models served today", () => {
  const ZOD = {
    now: nowResponseSchema,
    owner_now: ownerNowResponseSchema,
    search: operatorSearchReadModelSchema,
    job_history: jobHistoryResponseSchema,
    inventory_overview: inventoryOverviewResponseSchema,
    accounting_intent: accountingIntentDetailResponseSchema,
  } as const;

  const expand = (value: unknown, segments: readonly string[]): unknown[] => {
    if (segments.length === 0) return [value];
    const [head, ...rest] = segments as [string, ...string[]];
    if (head === "*")
      return Array.isArray(value) ? value.flatMap((item) => expand(item, rest)) : [];
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, head)) return [];
    return expand((value as Record<string, unknown>)[head], rest);
  };

  const conforms = (descriptor: FieldDescriptor, value: unknown): boolean => {
    if (typeof descriptor === "object") return "rows" in descriptor && Array.isArray(value);
    switch (descriptor) {
      case "text":
        return typeof value === "string" && value.trim() !== "";
      case "count":
        return Number.isSafeInteger(value) && (value as number) >= 0;
      case "when":
        return typeof value === "string" && !Number.isNaN(Date.parse(value));
      case "id":
        return typeof value === "string" && value !== "";
      default:
        return false;
    }
  };

  it.each(
    Object.entries(READ_MODELS)
      .filter(([, model]) => model.available)
      .map(([name]) => name),
  )("%s: the fixture matches the app contract and carries every published path", (name) => {
    const fixture = READ_MODEL_FIXTURES[name as keyof typeof READ_MODEL_FIXTURES];
    expect(fixture).toBeDefined();
    const schema = ZOD[name as keyof typeof ZOD];
    if (schema) expect(schema.safeParse(fixture).error).toBeUndefined();
    for (const [path, descriptor] of Object.entries(READ_MODELS[name]?.fields ?? {})) {
      const values = expand(fixture, path.split("/").slice(1));
      expect(values.length, `${name} ${path}`).toBeGreaterThan(0);
      for (const value of values) expect(conforms(descriptor, value), `${name} ${path}`).toBe(true);
    }
  });
});

describe("reading the contract catalog", () => {
  it("recognizes every action of the shipped contract", () => {
    // A typo in docs/AI-TEAM-CONTRACT.md would otherwise demote an action without a sound.
    expect(catalog.actions.filter((action) => action.recognized === false)).toEqual([]);
  });

  it("fails every copy of a repeated action id closed", () => {
    const contract = JSON.parse(CATALOG_JSON) as { actions: Record<string, unknown>[] };
    const note = contract.actions.find((action) => action.action_id === "note.add")!;
    contract.actions.unshift({ ...note, autonomy: "A4" });
    const built = catalogFromContractJson(JSON.stringify(contract), CATALOG_SHA256);
    const copies = built.actions.filter((action) => action.action_id === "note.add");
    expect(copies.map((action) => action.recognized)).toEqual([false, false]);
  });

  it("refuses an unrecognized action with that one action code", () => {
    const issues = issuesFor({
      spec: edit(list(), (draft) => {
        draft.actions = [{ ...noteAction("Pause the follow-up"), action_id: "followup.pause" }];
      }),
      catalog: futureCatalog,
    }).filter((issue) => issue.code.startsWith("action_") || issue.code === "unknown_action");
    expect(issues.map((issue) => issue.code)).toEqual(["action_not_recognized"]);
  });

  it("keeps working on a newer contract: unknown fields ignored, unknown terms never offered", () => {
    const paused = futureCatalog.actions.find((action) => action.action_id === "followup.pause");
    expect(paused?.recognized).toBe(false);
    expect(actionRequestKind(paused!)).toBeNull();
    expect(futureCatalog.actions.length).toBe(catalog.actions.length);
    const note = futureCatalog.actions.find((action) => action.action_id === "note.add");
    expect(note?.recognized).toBeUndefined();
  });

  it("throws only on a catalog that is not one", () => {
    expect(() =>
      catalogFromContractJson(JSON.stringify({ actions: [] }), CATALOG_SHA256),
    ).toThrow();
    expect(() =>
      catalogFromContractJson(
        JSON.stringify({ actions: [{ owners: [] }], specialists: [] }),
        CATALOG_SHA256,
      ),
    ).toThrow();
  });

  it("names the codes the Worker adds from the face run", () => {
    expect([...VIEW_SPEC_RUN_ISSUE_CODES]).toEqual(["source_not_in_snapshot", "run_mismatch"]);
    for (const code of VIEW_SPEC_RUN_ISSUE_CODES) expect(VIEW_SPEC_ISSUE_CODES).not.toContain(code);
  });
});
