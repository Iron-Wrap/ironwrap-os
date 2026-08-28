import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinkStub } from "../admin/admin-link-stub";
import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import type { AppRole } from "../lib/roles";
import { loadSchemaCard } from "./schema-card-api";
import type { SchemaCardEntry, SchemaCardFieldDefinition } from "./schema-card-contracts";
import { SchemaCardSection } from "./schema-card-section";

vi.mock("./schema-card-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schema-card-api")>()),
  loadSchemaCard: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

const loadSchemaCardMock = vi.mocked(loadSchemaCard);
const dateOptions = { locale: "en-CA", timeZone: "America/Edmonton" };

function entry(
  overrides: Partial<SchemaCardFieldDefinition>,
  value: unknown = undefined,
  writable = false,
): SchemaCardEntry {
  return {
    writable,
    definition: {
      field_id: `fld_${overrides.field_key ?? "default"}`,
      field_key: "permit_number",
      revision_id: "rev_1",
      version: 1,
      label: "Permit number",
      position: 0,
      field_type: "text",
      validator_key: "none",
      validator_config: {},
      visibility_key: "always",
      visibility_config: {},
      evidence_class: "none",
      retention_policy: "standard",
      offline_mode: "offline_read",
      ...overrides,
    },
    value:
      value === undefined
        ? null
        : {
            value_revision_id: "val_1",
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

function resolveCard(fields: SchemaCardEntry[], offline = false) {
  loadSchemaCardMock.mockResolvedValue({
    response: { entity_type: "job", entity_id: "JOB-1", fields },
    offline,
  });
}

function renderCard(role: AppRole) {
  return renderWithSession(
    <SchemaCardSection entityType="job" entityId="JOB-1" dateOptions={dateOptions} />,
    sessionFor(role),
  );
}

describe("the schema-driven job card", () => {
  beforeEach(() => {
    loadSchemaCardMock.mockReset();
  });

  it("renders a field an administrator defined, with its configured label and value", async () => {
    resolveCard([entry({ field_key: "permit_number", label: "Permit number" }, "CAL-2026-8891")]);

    renderCard("field");

    expect(await screen.findByText("Permit number")).toBeInTheDocument();
    expect(screen.getByTestId("schema-field-permit_number")).toHaveTextContent("CAL-2026-8891");
  });

  it("shows a configured but unfilled field as unrecorded instead of hiding it", async () => {
    resolveCard([entry({ field_key: "gate_code", label: "Gate code" })]);

    renderCard("field");

    expect(await screen.findByTestId("schema-field-gate_code")).toHaveTextContent("Not recorded");
  });

  it("renders two service types on one job as separate titled blocks", async () => {
    resolveCard([
      entry({ field_key: "roofing.underlayment", label: "Underlayment", position: 0 }, "Synthetic"),
      entry({ field_key: "gutters.linear_feet", label: "Linear feet", position: 1 }, "142"),
    ]);

    renderCard("field");

    expect(await screen.findByRole("heading", { name: "Roofing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Gutters" })).toBeInTheDocument();
    expect(screen.getByTestId("schema-field-roofing.underlayment")).toHaveTextContent("Synthetic");
    expect(screen.getByTestId("schema-field-gutters.linear_feet")).toHaveTextContent("142");
  });

  it("does not spend a group heading on a card that holds only one service type", async () => {
    resolveCard([entry({ field_key: "roofing.underlayment", label: "Underlayment" }, "Synthetic")]);

    renderCard("field");

    await screen.findByText("Underlayment");
    expect(screen.queryByRole("heading", { name: "Roofing" })).not.toBeInTheDocument();
  });

  it("hides a dependent field whose controlling field does not satisfy the configured rule", async () => {
    resolveCard([
      entry({ field_key: "service_kind", label: "Service kind", position: 0 }, "repair"),
      entry(
        {
          field_key: "replacement_squares",
          label: "Replacement squares",
          position: 1,
          visibility_key: "when_field_equals",
          visibility_config: { field_key: "service_kind", value: "replacement" },
        },
        18,
      ),
    ]);

    renderCard("field");

    expect(await screen.findByTestId("schema-field-service_kind")).toHaveTextContent("repair");
    expect(screen.queryByTestId("schema-field-replacement_squares")).not.toBeInTheDocument();
  });

  it("shows the dependent field once the controlling field matches", async () => {
    resolveCard([
      entry({ field_key: "service_kind", label: "Service kind", position: 0 }, "replacement"),
      entry(
        {
          field_key: "replacement_squares",
          label: "Replacement squares",
          position: 1,
          visibility_key: "when_field_equals",
          visibility_config: { field_key: "service_kind", value: "replacement" },
        },
        18,
      ),
    ]);

    renderCard("field");

    expect(await screen.findByTestId("schema-field-replacement_squares")).toHaveTextContent("18");
  });

  it("renders exactly what the server authorized, never a field it withheld", async () => {
    // The server omits an unreadable field entirely (proved against the response body in
    // workers-bus/test/schema-forms-api.test.ts). The card must not resurrect it from anywhere.
    resolveCard([entry({ field_key: "permit_number", label: "Permit number" }, "CAL-2026-8891")]);

    renderCard("field");

    await screen.findByTestId("schema-field-permit_number");
    expect(screen.queryByText("Margin band")).not.toBeInTheDocument();
    expect(screen.queryByTestId("schema-field-margin_band")).not.toBeInTheDocument();
  });

  it("says so when the values came from the device cache", async () => {
    resolveCard([entry({ field_key: "permit_number" }, "CAL-2026-8891")], true);

    renderCard("field");

    expect(await screen.findByText(/Showing the copy saved on this device/i)).toBeInTheDocument();
  });

  it("offers a retry rather than a blank card when the read fails", async () => {
    loadSchemaCardMock.mockRejectedValue(
      new ApiError({ status: 500, code: "server_error", message: "Something went wrong." }),
    );

    renderCard("field");

    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("the on-card way into configuration", () => {
  beforeEach(() => {
    loadSchemaCardMock.mockReset();
  });

  it("offers an owner the customizer, pointed at the existing configuration page", async () => {
    resolveCard([entry({ field_key: "permit_number" }, "CAL-2026-8891")]);

    renderCard("owner");

    const link = await screen.findByRole("link", { name: /customize fields/i });
    expect(link).toHaveAttribute("href", "/settings/configuration/fields");
  });

  it("offers it to nobody else", async () => {
    for (const role of ["field", "sales", "production", "accounting", "ops"] as const) {
      resolveCard([entry({ field_key: "permit_number" }, "CAL-2026-8891")]);
      const view = renderCard(role);
      await screen.findByTestId("schema-field-permit_number");
      expect(screen.queryByRole("link", { name: /customize fields/i })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("still reaches an owner whose account has no fields configured yet", async () => {
    resolveCard([]);

    renderCard("owner");

    expect(await screen.findByRole("link", { name: /customize fields/i })).toBeInTheDocument();
    expect(screen.getByText(/No fields are configured for this record yet/i)).toBeInTheDocument();
  });

  it("spends no space on a crew phone when nothing is configured", async () => {
    resolveCard([]);

    const view = renderCard("field");

    await waitFor(() => expect(loadSchemaCardMock).toHaveBeenCalled());
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });
});
