import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import type { AppRole } from "../lib/roles";
import { loadSchemaCard } from "../schema-forms/schema-card-api";
import type { SchemaCardEntry } from "../schema-forms/schema-card-contracts";
import { useCapability } from "../capabilities/capability-signal";
import type { Capability } from "../capabilities/capability-contracts";
import { generateEntityDocument, loadEntityDocuments } from "./document-api";
import type { EntityDocument } from "./document-contracts";
import { EntityDocumentsSection } from "./document-section";

vi.mock("../schema-forms/schema-card-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../schema-forms/schema-card-api")>()),
  loadSchemaCard: vi.fn(),
}));
vi.mock("./document-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./document-api")>()),
  loadEntityDocuments: vi.fn(),
  generateEntityDocument: vi.fn(),
}));
vi.mock("../capabilities/capability-signal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/capability-signal")>()),
  useCapability: vi.fn(),
}));

const loadSchemaCardMock = vi.mocked(loadSchemaCard);
const loadEntityDocumentsMock = vi.mocked(loadEntityDocuments);
const generateEntityDocumentMock = vi.mocked(generateEntityDocument);
const useCapabilityMock = vi.mocked(useCapability);
const dateOptions = { locale: "en-CA", timeZone: "America/Edmonton" };

function entry(fieldKey: string, label: string, value: unknown): SchemaCardEntry {
  return {
    definition: {
      field_id: `fld_${fieldKey}`,
      field_key: fieldKey,
      revision_id: "rev_1",
      version: 1,
      label,
      position: 0,
      field_type: "text",
      validator_key: "none",
      validator_config: {},
      visibility_key: "always",
      visibility_config: {},
      evidence_class: "none",
      retention_policy: "standard",
      offline_mode: "offline_read",
    },
    value: {
      value_revision_id: `val_${fieldKey}`,
      field_definition_revision_id: "rev_1",
      version: 1,
      prior_value_revision_id: null,
      based_on_value_revision_id: null,
      correction_reason: null,
      value,
      value_digest: "digest",
      provenance_actor_type: "owner",
      created_at: "2026-08-27T18:00:00.000Z",
    },
  } as SchemaCardEntry;
}

/** A field the reader may read but nobody has filled in yet. */
function unfilled(fieldKey: string, label: string): SchemaCardEntry {
  return { ...entry(fieldKey, label, null), value: null } as SchemaCardEntry;
}

const materialsList: EntityDocument = {
  template_id: "tpl_materials",
  template_key: "materials_list",
  label: "Materials list",
  revision_id: "rev_tpl_1",
  version: 1,
  blocks: [
    { kind: "heading", level: 1, text: "Order for the shop" },
    { kind: "field", field_id: "fld_bundles" },
    { kind: "field", field_id: "fld_underlayment" },
  ],
};

function resolve(documents: EntityDocument[], fields: SchemaCardEntry[], offline = false) {
  loadEntityDocumentsMock.mockResolvedValue({
    response: { entity_type: "job", entity_id: "JOB-1", documents },
    offline,
  });
  loadSchemaCardMock.mockResolvedValue({
    response: { entity_type: "job", entity_id: "JOB-1", fields },
    offline,
  });
}

function renderSection(role: AppRole = "production") {
  return renderWithSession(
    <EntityDocumentsSection entityType="job" entityId="JOB-1" dateOptions={dateOptions} />,
    sessionFor(role),
  );
}

const filledCard = [
  entry("bundles", "Bundles", "42"),
  entry("underlayment", "Underlayment", "Synthetic"),
];

beforeEach(() => {
  vi.clearAllMocks();
  // The committed reference configuration does not list document generation for a scoped role;
  // for the owner the tests set the state they need.
  useCapabilityMock.mockReturnValue({ status: "not_visible" });
});

const generationOff: Capability = {
  id: "document_generation",
  title: "Document generation",
  presence: "present",
  state: "off",
  reason: "flag_off",
  flag_state: "off",
  configuration_state: "not_evaluated",
  readback_required: true,
};

const receipt = {
  receipt_id: "dgr_0001",
  generation_attempt_id: "dga_0001",
  receipt_version: 1,
  template_id: "tpl_materials",
  template_version: 1,
  provider: "r2",
  provider_document_id: "documents/freshco/dga_0001.html",
  output_digest: "a".repeat(64),
  readback_status: "matched",
  terminal_status: "succeeded",
  reconciliation_outcome: "succeeded",
};

describe("EntityDocumentsSection", () => {
  it("reaches the job's materials list and fills it from that job's values", async () => {
    resolve([materialsList], filledCard);
    renderSection();

    expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /materials list/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("document-line-bundles")).toHaveTextContent("42");
    expect(screen.getByTestId("document-line-underlayment")).toHaveTextContent("Synthetic");
    expect(screen.getByRole("heading", { name: "Order for the shop" })).toBeInTheDocument();
    expect(loadEntityDocumentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ role: "production" }) }),
      "job",
      "JOB-1",
    );
  });

  /**
   * The reader never receives a value their role may not read, so the document cannot render one.
   * The line stays, marked, rather than vanishing — a materials list silently missing a line is
   * one the shop would order from.
   */
  it("marks a line the reader's authority did not reach, and never invents its value", async () => {
    resolve([materialsList], [entry("bundles", "Bundles", "42")]);
    renderSection("field");

    expect(await screen.findByTestId("document-line-bundles")).toHaveTextContent("42");
    expect(screen.getByTestId("document-line-fld_underlayment")).toHaveTextContent(
      "Not shared with your role",
    );
    expect(screen.getByTestId("document-withheld-note")).toHaveTextContent(
      "One line is not shared with your role.",
    );
    expect(screen.queryByText("Synthetic")).not.toBeInTheDocument();
  });

  /**
   * The designer's blocking finding (ELEC-197): a shop scanning a materials list must tell "ask
   * the office" from "you are not allowed to see this" without stopping to read each row. The two
   * states carry different markup, not only different words.
   */
  it("separates a withheld line from an unfilled one by more than its wording", async () => {
    const withMargin = {
      ...materialsList,
      blocks: [...materialsList.blocks, { kind: "field" as const, field_id: "fld_margin_band" }],
    };
    resolve(
      [withMargin],
      [entry("bundles", "Bundles", "42"), unfilled("underlayment", "Underlayment")],
    );
    renderSection("field");

    const empty = (await screen.findByTestId("document-line-underlayment")).closest(
      "[data-line-state]",
    );
    const withheld = screen
      .getByTestId("document-line-fld_margin_band")
      .closest("[data-line-state]");

    expect(empty).toHaveAttribute("data-line-state", "empty");
    expect(withheld).toHaveAttribute("data-line-state", "withheld");
    // A lock and a left edge the empty row does not carry.
    expect(withheld?.className).toContain("border-l-2");
    expect(empty?.className).not.toContain("border-l-2");
    expect(withheld?.querySelector("svg")).not.toBeNull();
    expect(empty?.querySelector("svg")).toBeNull();
    // And the placeholder no longer wears a real field label's weight.
    expect(screen.getByText("Hidden line").className).toContain("italic");
  });

  it("stays off the page entirely when the account configured no document for this record", async () => {
    resolve([], filledCard);
    const { container } = renderSection();

    await waitFor(() => expect(loadEntityDocumentsMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector("[data-testid='entity-documents']")).toBeNull(),
    );
    expect(screen.queryByRole("heading", { name: "Documents" })).not.toBeInTheDocument();
  });

  it("hides a document the reader may read no line of", async () => {
    resolve([materialsList], []);
    renderSection("field");

    await waitFor(() => expect(loadSchemaCardMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /materials list/i })).not.toBeInTheDocument(),
    );
  });

  it("opens the first document on the shelf and lets another be opened on a phone", async () => {
    resolve(
      [
        materialsList,
        {
          ...materialsList,
          template_id: "tpl_contract",
          template_key: "contract",
          label: "Contract",
        },
      ],
      filledCard,
    );
    renderSection("owner");

    // Sorted by label, so "Contract" leads the shelf and opens; "Materials list" waits for a tap.
    expect(await screen.findByTestId("document-toggle-contract")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const materials = screen.getByTestId("document-toggle-materials_list");
    expect(materials).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(materials);
    expect(materials).toHaveAttribute("aria-expanded", "true");
  });

  it("says the copy is the one saved on the device when the read fell back offline", async () => {
    resolve([materialsList], filledCard, true);
    renderSection("field");

    expect(await screen.findByTestId("documents-offline-notice")).toHaveTextContent(
      /These documents are the copy saved on this device/i,
    );
  });

  it("surfaces a failed read instead of an empty shelf", async () => {
    loadEntityDocumentsMock.mockRejectedValue(
      new ApiError({ message: "Service unavailable.", status: 503 }),
    );
    loadSchemaCardMock.mockResolvedValue({
      response: { entity_type: "job", entity_id: "JOB-1", fields: filledCard },
      offline: false,
    });
    renderSection();

    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  describe("making the document (owner)", () => {
    it("lets the owner make the document and shows the receipt the server wrote", async () => {
      resolve([materialsList], filledCard);
      generateEntityDocumentMock.mockResolvedValue({
        outcome: "succeeded",
        generation: receipt,
        attachment: null,
      });
      renderSection("owner");
      const make = await screen.findByRole("button", { name: "Make this document" });
      await userEvent.click(make);
      expect(await screen.findByText("Document made")).toBeInTheDocument();
      expect(screen.getByText(/Receipt dgr_0001/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open the document" })).toHaveAttribute(
        "href",
        "/api/v1/document-generations/dgr_0001/document",
      );
      expect(screen.queryByRole("button", { name: "Make this document" })).not.toBeInTheDocument();
      expect(generateEntityDocumentMock).toHaveBeenCalledTimes(1);
      const [, input] = generateEntityDocumentMock.mock.calls[0]!;
      expect(input).toMatchObject({
        entityType: "job",
        entityId: "JOB-1",
        templateId: "tpl_materials",
        templateRevisionId: "rev_tpl_1",
      });
      expect(input.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,140}$/);
    });

    it.each<AppRole>(["production", "ops", "field"])("offers nothing to %s", async (role) => {
      resolve([materialsList], filledCard);
      renderSection(role);
      await screen.findByTestId("document-toggle-materials_list");
      expect(screen.queryByRole("button", { name: "Make this document" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("document-generation")).not.toBeInTheDocument();
    });

    it("shows the owner the off state instead of a control when generation is switched off", async () => {
      useCapabilityMock.mockReturnValue({ status: "known", capability: generationOff });
      resolve([materialsList], filledCard);
      renderSection("owner");
      expect(await screen.findByText("Document generation is turned off")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Make this document" })).not.toBeInTheDocument();
      expect(generateEntityDocumentMock).not.toHaveBeenCalled();
    });

    it("shows a refused outcome with its receipt and replays the same key on retry", async () => {
      resolve([materialsList], filledCard);
      generateEntityDocumentMock.mockRejectedValue(
        new ApiError({
          status: 409,
          code: "api_error",
          message: "Conflict",
          details: {
            outcome: "not_executed",
            generation: {
              ...receipt,
              provider_document_id: null,
              readback_status: null,
              terminal_status: "not_executed",
              reconciliation_outcome: "not_executed",
            },
            attachment: null,
          },
        }),
      );
      renderSection("owner");
      await userEvent.click(await screen.findByRole("button", { name: "Make this document" }));
      expect(await screen.findByText("Not made")).toBeInTheDocument();
      expect(screen.getByText(/Receipt dgr_0001/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(generateEntityDocumentMock).toHaveBeenCalledTimes(2));
      const keys = generateEntityDocumentMock.mock.calls.map(([, input]) => input.idempotencyKey);
      expect(keys[0]).toBe(keys[1]);
    });

    it("offers no file for an unconfirmed write and keeps the job context when the sign-in ends", async () => {
      resolve([materialsList], filledCard);
      generateEntityDocumentMock.mockResolvedValueOnce({
        outcome: "unknown",
        generation: {
          ...receipt,
          provider_document_id: null,
          readback_status: null,
          terminal_status: null,
          reconciliation_outcome: "unknown",
        },
        attachment: null,
      });
      renderSection("owner");
      await userEvent.click(await screen.findByRole("button", { name: "Make this document" }));
      expect(await screen.findByText("Not confirmed yet")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open the document" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

      generateEntityDocumentMock.mockRejectedValueOnce(
        new ApiError({ status: 401, code: "session_invalid", message: "Sign in again." }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByText("Your sign-in ended before this was made"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("document-toggle-materials_list")).toBeInTheDocument();
      const keys = generateEntityDocumentMock.mock.calls.map(([, input]) => input.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
    });

    it("says generation is switched off in this environment when the server refuses it as unavailable", async () => {
      resolve([materialsList], filledCard);
      generateEntityDocumentMock.mockRejectedValue(
        new ApiError({
          status: 503,
          code: "document_generation_unavailable",
          message: "Service unavailable",
        }),
      );
      renderSection("owner");
      await userEvent.click(await screen.findByRole("button", { name: "Make this document" }));
      expect(
        await screen.findByText("Document generation is switched off here"),
      ).toBeInTheDocument();
    });
  });
});
