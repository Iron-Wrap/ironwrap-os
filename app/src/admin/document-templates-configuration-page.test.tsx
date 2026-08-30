import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  documentBlockSchema,
  entityDocumentSchema,
  type DocumentBlock,
} from "../documents/document-contracts";
import {
  createDocumentTemplate,
  loadAdminPipelines,
  loadDocumentTemplateHistory,
  loadDocumentTemplates,
  loadSchemaFields,
  retireDocumentTemplate,
  reviseDocumentTemplate,
} from "./configuration-api";
import type {
  AdminDocumentTemplate,
  AdminPipelineListResponse,
  DocumentTemplateListResponse,
  SchemaField,
  SchemaFieldListResponse,
} from "./configuration-contracts";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import {
  DocumentTemplatesConfigurationPage,
  documentBlocksProblem,
  sortDocumentTemplates,
} from "./document-templates-configuration-page";

vi.mock("./configuration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./configuration-api")>()),
  createDocumentTemplate: vi.fn(),
  loadAdminPipelines: vi.fn(),
  loadDocumentTemplateHistory: vi.fn(),
  loadDocumentTemplates: vi.fn(),
  loadSchemaFields: vi.fn(),
  retireDocumentTemplate: vi.fn(),
  reviseDocumentTemplate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
}

const actor = {
  type: "owner",
  role: "owner",
  id: "appu_owner",
  authority_ref: "app:appu_owner",
} as const;

function schemaField(
  key: string,
  label: string,
  overrides: Partial<SchemaField> = {},
): SchemaField {
  return {
    field_id: `field_${key}`,
    entity_type: "job",
    field_key: key,
    revision_id: `fieldrev_${key}_1`,
    version: 1,
    prior_revision_id: null,
    action: "create",
    label,
    position: 0,
    field_type: "text",
    validator_key: "none",
    validator_config: {},
    visibility_key: "always",
    visibility_config: {},
    evidence_class: "none",
    retention_policy: "standard",
    offline_mode: "online_only",
    read_scope: "all",
    write_scope: "all",
    read_roles: ["owner"],
    write_roles: ["owner"],
    active: true,
    actor: { ...actor },
    command_fingerprint: "a".repeat(64),
    effective_at: "2026-08-27T10:00:00.000Z",
    created_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function template(
  key: string,
  label: string,
  overrides: Partial<AdminDocumentTemplate> = {},
): AdminDocumentTemplate {
  return {
    template_id: `template:${key.padEnd(40, "0")}`,
    revision_id: `docrev:${key}:1`,
    version: 1,
    prior_revision_id: null,
    action: "create",
    entity_type: "job",
    template_key: key,
    label,
    blocks: [
      { kind: "heading", level: 2, text: "Materials" },
      { kind: "field", field_id: "field_quantity" },
    ],
    retention_policy: "standard",
    active: true,
    actor: { ...actor },
    command_fingerprint: "b".repeat(64),
    effective_at: "2026-08-27T10:00:00.000Z",
    created_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

const fieldsResponse: SchemaFieldListResponse = {
  version: 1,
  catalog: {
    roles: ["owner"],
    field_types: ["text"],
    validators: ["none"],
    visibility_rules: ["always"],
    evidence_classes: ["none"],
    retention_policies: ["standard", "extended"],
    offline_modes: ["online_only"],
    scopes: ["all"],
  },
  // Served in creation order, positioned in reading order: the picker must follow the positions,
  // or it disagrees with the Fields screen about the same list.
  fields: [
    schemaField("quantity", "Quantity", { position: 2 }),
    schemaField("material", "Material", { position: 1 }),
    // Retired: a document may not bind to it, so it must never be offered.
    schemaField("legacy", "Legacy note", { active: false }),
    // Another record type: out of scope for a job document.
    schemaField("source", "Lead source", { entity_type: "lead" }),
  ],
};

const pipelineCatalog: AdminPipelineListResponse = {
  version: 1,
  entity_types: [
    { entity_type: "job", label: "Job" },
    { entity_type: "lead", label: "Lead" },
  ],
  roles: ["owner"],
  stage_limit: 200,
  pipelines: [],
};

function documentsResponse(templates: AdminDocumentTemplate[]): DocumentTemplateListResponse {
  return {
    version: 1,
    catalog: {
      actions: ["create", "revise", "retire"],
      block_kinds: ["text", "heading", "field"],
      retention_policies: ["standard", "extended"],
    },
    templates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setOnline(true);
  vi.mocked(loadAdminPipelines).mockResolvedValue(pipelineCatalog);
  vi.mocked(loadSchemaFields).mockResolvedValue(fieldsResponse);
});

describe("document template authoring", () => {
  it("creates a document whose blocks reference schema fields, entirely from the UI", async () => {
    vi.mocked(loadDocumentTemplates).mockResolvedValue(documentsResponse([]));
    vi.mocked(createDocumentTemplate).mockResolvedValue({
      outcome: "created",
      template: template("materials-list", "Materials list"),
    });
    const user = userEvent.setup();
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New document" }));
    await user.type(screen.getByLabelText("Name"), "Materials list");
    await user.type(screen.getByLabelText("Key"), "materials-list");
    await user.selectOptions(screen.getByLabelText("Belongs to"), "job");

    await user.click(screen.getByRole("button", { name: "Add heading" }));
    await user.type(screen.getByLabelText("Heading text"), "Materials");
    await user.click(screen.getByRole("button", { name: "Add field" }));

    // Only the active fields of the chosen record type are on offer: binding to a retired field,
    // or to another record type's field, is a save the server would refuse.
    const fieldSelect = screen.getByLabelText("Field");
    expect(
      [...(fieldSelect as HTMLSelectElement).options].map((option) => option.textContent),
    ).toEqual(["Choose a field", "Material", "Quantity"]);
    await user.selectOptions(fieldSelect, "field_quantity");

    await user.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() => expect(createDocumentTemplate).toHaveBeenCalledOnce());
    expect(vi.mocked(createDocumentTemplate).mock.calls[0]?.[1]).toEqual({
      entity_type: "job",
      template_key: "materials-list",
      label: "Materials list",
      retention_policy: "standard",
      blocks: [
        { kind: "heading", level: 2, text: "Materials" },
        { kind: "field", field_id: "field_quantity" },
      ],
    });
  });

  it("refuses to save a document that is not filled from the record", async () => {
    vi.mocked(loadDocumentTemplates).mockResolvedValue(documentsResponse([]));
    const user = userEvent.setup();
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New document" }));
    await user.type(screen.getByLabelText("Name"), "Thank-you note");
    await user.type(screen.getByLabelText("Key"), "thank-you");
    await user.click(screen.getByRole("button", { name: "Add heading" }));
    await user.type(screen.getByLabelText("Heading text"), "Thank you");
    await user.click(screen.getByRole("button", { name: "Save document" }));

    expect(
      await screen.findByText(
        "Add at least one field, so this document is filled from the record it is opened on.",
      ),
    ).toBeVisible();
    expect(createDocumentTemplate).not.toHaveBeenCalled();
  });

  it("reorders blocks from the keyboard and saves the order it shows", async () => {
    vi.mocked(loadDocumentTemplates).mockResolvedValue(
      documentsResponse([template("materials-list", "Materials list")]),
    );
    vi.mocked(reviseDocumentTemplate).mockResolvedValue({
      outcome: "created",
      template: template("materials-list", "Materials list", { version: 2 }),
    });
    const user = userEvent.setup();
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const moveUp = screen.getByRole("button", { name: "Move Field 2 up" });
    moveUp.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Save revision" }));

    await waitFor(() => expect(reviseDocumentTemplate).toHaveBeenCalledOnce());
    expect(vi.mocked(reviseDocumentTemplate).mock.calls[0]?.[2]).toMatchObject({
      expected_version: 1,
      blocks: [
        { kind: "field", field_id: "field_quantity" },
        { kind: "heading", level: 2, text: "Materials" },
      ],
    });
  });

  it("retires a document behind a confirmation and keeps every revision readable", async () => {
    const current = template("materials-list", "Materials list");
    vi.mocked(loadDocumentTemplates).mockResolvedValue(documentsResponse([current]));
    vi.mocked(retireDocumentTemplate).mockResolvedValue({
      outcome: "created",
      template: { ...current, version: 2, action: "retire", active: false },
    });
    vi.mocked(loadDocumentTemplateHistory).mockResolvedValue({
      template_id: current.template_id,
      current_revision_id: `docrev:materials-list:2`,
      current_version: 2,
      revisions: [
        current,
        {
          ...current,
          version: 2,
          revision_id: "docrev:materials-list:2",
          prior_revision_id: current.revision_id,
          action: "retire",
          active: false,
        },
      ],
    });
    const user = userEvent.setup();
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));

    // Retiring is never one tap: it takes a document out of every future job.
    await user.click(await screen.findByRole("button", { name: "Retire" }));
    expect(screen.getByText("Retire this document?")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retire document" }));
    await waitFor(() => expect(retireDocumentTemplate).toHaveBeenCalledOnce());
    expect(vi.mocked(retireDocumentTemplate).mock.calls[0]?.[1]).toMatchObject({
      template_id: current.template_id,
      version: 1,
    });

    await user.click(screen.getByRole("button", { name: "History" }));
    const history = await screen.findByText("Immutable history");
    const panel = history.parentElement as HTMLElement;
    // The retire is a revision, not a deletion: what the document said before it is still there.
    expect(within(panel).getByText(/Revision 1 · created/)).toBeVisible();
    expect(within(panel).getByText(/Revision 2 · retired/)).toBeVisible();
  });

  it("shows a retired document as history rather than as work, and will not edit it", async () => {
    vi.mocked(loadDocumentTemplates).mockResolvedValue(
      documentsResponse([
        template("old-contract", "Old contract", { active: false, action: "retire", version: 3 }),
      ]),
    );
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));

    // The pill on the card and the notice inside it both say so, which is the point.
    expect(await screen.findAllByText("Retired")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeDisabled();
    // History stays open to everyone: retiring hides the document, it does not erase the record.
    expect(screen.getByRole("button", { name: "History" })).toBeEnabled();
  });

  it("keeps the whole screen read-only offline and queues nothing", async () => {
    vi.mocked(loadDocumentTemplates).mockResolvedValue(
      documentsResponse([template("materials-list", "Materials list")]),
    );
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));
    expect(await screen.findByText("Materials list")).toBeVisible();

    setOnline(false);
    act(() => window.dispatchEvent(new Event("offline")));

    expect(await screen.findByText("Offline: configuration is read-only")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New document" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(createDocumentTemplate).not.toHaveBeenCalled();

    // Hand the connection back while this test's tree is still mounted. React Query's online
    // manager is module-level and only listens to the window while something is subscribed to it,
    // so an "online" event dispatched after the last provider unmounts is never observed: the
    // manager stays offline and the NEXT test's queries mount paused, with its query function
    // never called. Restoring it here, in front of a live observer, is what makes that not happen.
    setOnline(true);
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(screen.getByRole("button", { name: "New document" })).toBeEnabled());
  });
});

/**
 * The other seat boundary: what an owner AUTHORS here and what a crew READS on the job.
 *
 * `documentBlockSchema` is imported from the reading surface rather than redeclared, so the two
 * halves are the same object — but "same object" is a claim about today's imports, and the point of
 * ELEC-195 / PR #203 was that agreement across a boundary should be PROVEN, not assumed. These
 * assertions fail the moment either half moves without the other.
 */
describe("agreeing with the surface that reads these documents", () => {
  it("submits a layout the reader half's own schema accepts, block kind for block kind", async () => {
    vi.mocked(loadDocumentTemplates).mockResolvedValue(documentsResponse([]));
    vi.mocked(createDocumentTemplate).mockResolvedValue({
      outcome: "created",
      template: template("contract", "Contract"),
    });
    const user = userEvent.setup();
    renderWithSession(<DocumentTemplatesConfigurationPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "New document" }));
    await user.type(screen.getByLabelText("Name"), "Contract");
    await user.type(screen.getByLabelText("Key"), "contract");
    // One of every kind the editor can produce, so no kind reaches the crew unproven.
    await user.click(screen.getByRole("button", { name: "Add heading" }));
    await user.type(screen.getByLabelText("Heading text"), "Agreement");
    await user.click(screen.getByRole("button", { name: "Add text" }));
    await user.type(screen.getByLabelText("Paragraph"), "Work to be carried out as described.");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.selectOptions(screen.getByLabelText("Field"), "field_material");
    await user.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() => expect(createDocumentTemplate).toHaveBeenCalledOnce());
    const authored = vi.mocked(createDocumentTemplate).mock.calls[0]?.[1].blocks ?? [];
    expect(authored.map((entry) => entry.kind)).toEqual(["heading", "text", "field"]);
    for (const entry of authored) {
      expect(() => documentBlockSchema.parse(entry), JSON.stringify(entry)).not.toThrow();
    }
  });

  it("publishes a stored template the job-card reader consumes verbatim", () => {
    // The authoring response and the record-scoped document read carry the same layout. If the
    // administration view ever stopped satisfying the reader's contract, a document an owner
    // authored would render as an empty shelf on the job rather than fail here.
    const stored = template("materials-list", "Materials list");
    const asRead = entityDocumentSchema.parse(stored);
    expect(asRead.blocks).toEqual(stored.blocks);
    expect(asRead.template_id).toBe(stored.template_id);
    expect(asRead.version).toBe(stored.version);
  });

  it("refuses a block kind the reader half does not know", () => {
    expect(() => documentBlockSchema.parse({ kind: "signature", text: "sign here" })).toThrow();
  });
});

describe("document layout rules", () => {
  it("names the reason a layout cannot be saved", () => {
    expect(documentBlocksProblem([])).toBe("Add at least one block to this document.");
    expect(documentBlocksProblem([{ kind: "heading", level: 1, text: "  " }])).toBe(
      "Every heading and paragraph needs text.",
    );
    expect(documentBlocksProblem([{ kind: "text", text: "<b>bold</b>" }])).toBe(
      "Remove the angle brackets from the text. Documents hold plain text.",
    );
    expect(documentBlocksProblem([{ kind: "text", text: "Thank you" }])).toBe(
      "Add at least one field, so this document is filled from the record it is opened on.",
    );
    const duplicated: DocumentBlock[] = [
      { kind: "field", field_id: "field_quantity" },
      { kind: "field", field_id: "field_quantity" },
    ];
    expect(documentBlocksProblem(duplicated)).toBe(
      "The same field is used twice. Each field can appear once in a document.",
    );
    expect(documentBlocksProblem([{ kind: "field", field_id: "" }])).toBe(
      "Choose a field for every field block.",
    );
    expect(
      documentBlocksProblem([
        { kind: "heading", level: 2, text: "Materials" },
        { kind: "field", field_id: "field_quantity" },
      ]),
    ).toBeNull();
  });

  it("puts documents in use above retired ones", () => {
    const order = sortDocumentTemplates([
      template("z-current", "Z current"),
      template("old", "Old", { active: false }),
      template("a-current", "A current"),
    ]).map((entry) => entry.label);
    expect(order).toEqual(["A current", "Z current", "Old"]);
  });
});
