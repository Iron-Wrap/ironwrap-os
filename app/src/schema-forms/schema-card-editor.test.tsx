import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkStub } from "../admin/admin-link-stub";
import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import type { AppRole } from "../lib/roles";
import type { OutboxAction } from "../storage/outbox-types";
import {
  loadSchemaCard,
  pendingSchemaCardWrites,
  queueSchemaCardValue,
  writeSchemaCardValue,
} from "./schema-card-api";
import type {
  SchemaCardEntry,
  SchemaCardFieldDefinition,
  SchemaCardModel,
} from "./schema-card-contracts";
import { SchemaCardSection } from "./schema-card-section";

/**
 * Filling in an administrator-defined field, from the surface a crew member actually holds.
 *
 * These drive the whole section rather than the editor alone, because the acceptance this closes
 * is about what a person can do on the card: the edit affordance, the refusal they read, the
 * conflict they resolve, and the value that survives a dead network. The transport is mocked; the
 * decisions are not.
 */

vi.mock("./schema-card-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schema-card-api")>()),
  loadSchemaCard: vi.fn(),
  writeSchemaCardValue: vi.fn(),
  queueSchemaCardValue: vi.fn(),
  pendingSchemaCardWrites: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

const loadSchemaCardMock = vi.mocked(loadSchemaCard);
const writeSchemaCardValueMock = vi.mocked(writeSchemaCardValue);
const queueSchemaCardValueMock = vi.mocked(queueSchemaCardValue);
const pendingSchemaCardWritesMock = vi.mocked(pendingSchemaCardWrites);

const dateOptions = { locale: "en-CA", timeZone: "America/Edmonton" };
const onlineDescriptor = Object.getOwnPropertyDescriptor(
  window.Navigator.prototype,
  "onLine",
) as PropertyDescriptor;

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
}

function definition(overrides: Partial<SchemaCardFieldDefinition> = {}): SchemaCardFieldDefinition {
  return {
    field_id: `fld_${overrides.field_key ?? "permit_number"}`,
    field_key: "permit_number",
    revision_id: "rev_permit_1",
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
    offline_mode: "queueable",
    ...overrides,
  } as SchemaCardFieldDefinition;
}

function entry(
  overrides: Partial<SchemaCardFieldDefinition>,
  options: { value?: unknown; version?: number; writable?: boolean } = {},
): SchemaCardEntry {
  const held = options.value;
  return {
    writable: options.writable ?? true,
    definition: definition(overrides),
    value:
      held === undefined
        ? null
        : {
            value_revision_id: `val_${options.version ?? 1}`,
            field_definition_revision_id: "rev_permit_1",
            version: options.version ?? 1,
            prior_value_revision_id: null,
            based_on_value_revision_id: null,
            correction_reason: null,
            value: held,
            value_digest: "digest",
            provenance_actor_type: "worker",
            created_at: "2026-08-27T18:00:00.000Z",
          },
  } as SchemaCardEntry;
}

function model(fields: SchemaCardEntry[], offline = false): SchemaCardModel {
  return {
    response: { entity_type: "job", entity_id: "JOB-1", fields },
    offline,
  } as SchemaCardModel;
}

function renderCard(role: AppRole = "field") {
  return renderWithSession(
    <SchemaCardSection entityType="job" entityId="JOB-1" dateOptions={dateOptions} />,
    sessionFor(role),
  );
}

function queuedAction(payload: Record<string, unknown>): OutboxAction {
  return {
    deviceActionId: "device-action-1",
    tenantId: "freshco",
    userId: "appu_field",
    kind: "schema_field_value",
    endpoint: "/api/v1/schema-fields/job/JOB-1/fld_permit_number/values",
    method: "POST",
    payload: payload as OutboxAction["payload"],
    attachments: [],
    state: "queued",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    version: 2,
  };
}

beforeEach(() => {
  setOnline(true);
  pendingSchemaCardWritesMock.mockResolvedValue(new Map());
});

afterEach(() => {
  Object.defineProperty(window.Navigator.prototype, "onLine", onlineDescriptor);
});

describe("a crew member filling in a configured field", () => {
  it("saves the value and shows the record's own copy back", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock
      .mockResolvedValueOnce(model([entry({ field_key: "permit_number" })]))
      .mockResolvedValue(
        model([entry({ field_key: "permit_number" }, { value: "CAL-2026-8891" })]),
      );
    writeSchemaCardValueMock.mockResolvedValue({
      outcome: "created",
      value: { version: 2 },
    } as never);

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.type(screen.getByTestId("schema-field-input-permit_number"), "CAL-2026-8891");
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    await waitFor(() =>
      expect(screen.getByTestId("schema-field-permit_number")).toHaveTextContent("CAL-2026-8891"),
    );
    expect(writeSchemaCardValueMock.mock.calls[0]?.[1]).toMatchObject({
      entityType: "job",
      entityId: "JOB-1",
      fieldId: "fld_permit_number",
      fieldDefinitionRevisionId: "rev_permit_1",
      expectedVersion: 0,
      value: "CAL-2026-8891",
      basedOnValueRevisionId: null,
      correctionReason: null,
    });
  });

  it("follows the value's version, so a second entry does not overwrite blind", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock.mockResolvedValue(
      model([entry({ field_key: "permit_number" }, { value: "CAL-1", version: 3 })]),
    );
    writeSchemaCardValueMock.mockResolvedValue({ outcome: "created", value: {} } as never);

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    await waitFor(() => expect(writeSchemaCardValueMock).toHaveBeenCalled());
    expect(writeSchemaCardValueMock.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 3 });
  });

  it("offers the administrator's own options rather than a free-text box", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock.mockResolvedValue(
      model([
        entry(
          {
            field_key: "deck_condition",
            label: "Deck condition",
            field_type: "select",
            validator_key: "options",
            validator_config: { options: ["Sound", "Soft sheets", "Replace"] },
          },
          { value: "Sound" },
        ),
      ]),
    );
    writeSchemaCardValueMock.mockResolvedValue({ outcome: "created", value: {} } as never);

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-deck_condition"));
    await user.selectOptions(screen.getByTestId("schema-field-input-deck_condition"), "Replace");
    await user.click(screen.getByTestId("schema-field-save-deck_condition"));

    await waitFor(() => expect(writeSchemaCardValueMock).toHaveBeenCalled());
    expect(writeSchemaCardValueMock.mock.calls[0]?.[1]).toMatchObject({ value: "Replace" });
  });
});

describe("a field this caller may not write", () => {
  it("renders read-only, with no control to press and no write attempted", async () => {
    loadSchemaCardMock.mockResolvedValue(
      model([
        entry(
          { field_key: "margin_band", label: "Margin band" },
          {
            value: "Band C",
            writable: false,
          },
        ),
      ]),
    );

    renderCard();

    expect(await screen.findByTestId("schema-field-margin_band")).toHaveTextContent("Band C");
    expect(screen.queryByTestId("schema-field-edit-margin_band")).not.toBeInTheDocument();
    expect(screen.queryByTestId("schema-field-input-margin_band")).not.toBeInTheDocument();
    expect(writeSchemaCardValueMock).not.toHaveBeenCalled();
  });

  it("stays read-only when the server has not published the flag at all", async () => {
    // Exactly the posture #200 shipped. Until `writable` arrives, the card offers nothing rather
    // than guessing — a guess is either an edit that 403s or an authority rule re-derived here.
    const withoutFlag = entry(
      { field_key: "permit_number" },
      { value: "CAL-1" },
    ) as SchemaCardEntry & {
      writable?: boolean;
    };
    delete withoutFlag.writable;
    loadSchemaCardMock.mockResolvedValue(model([withoutFlag]));

    renderCard();

    expect(await screen.findByTestId("schema-field-permit_number")).toHaveTextContent("CAL-1");
    expect(screen.queryByTestId("schema-field-edit-permit_number")).not.toBeInTheDocument();
  });
});

describe("a value the server refuses", () => {
  it("says what the administrator's rule wants, and keeps the entry in the box", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock.mockResolvedValue(
      model([
        entry({
          field_key: "crew_size",
          label: "Crew size",
          field_type: "integer",
          validator_key: "range",
          validator_config: { min: 1, max: 8 },
        }),
      ]),
    );
    writeSchemaCardValueMock.mockRejectedValue(
      new ApiError({ status: 400, code: "schema_field_range_invalid", message: "Bad Request" }),
    );

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-crew_size"));
    await user.type(screen.getByTestId("schema-field-input-crew_size"), "40");
    await user.click(screen.getByTestId("schema-field-save-crew_size"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a number between 1 and 8.");
    // Nothing was discarded: the entry is still there to correct.
    expect(screen.getByTestId("schema-field-input-crew_size")).toHaveValue(40);
  });

  it("tells a crew member to ask the office when the server refuses their role", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock.mockResolvedValue(model([entry({ field_key: "permit_number" })]));
    writeSchemaCardValueMock.mockRejectedValue(
      new ApiError({ status: 403, code: "schema_field_write_forbidden", message: "Forbidden" }),
    );

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.type(screen.getByTestId("schema-field-input-permit_number"), "CAL-1");
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/ask the office/i);
  });
});

describe("two people changing the same field", () => {
  const conflict = () =>
    new ApiError({
      status: 409,
      code: "schema_field_value_version_conflict",
      message: "Conflict",
      details: { expected_version: 1, current_version: 2 },
    });

  it("shows an ordinary field's two values and replaces against the version that won", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock
      .mockResolvedValueOnce(
        model([entry({ field_key: "permit_number" }, { value: "CAL-1", version: 1 })]),
      )
      .mockResolvedValue(
        model([entry({ field_key: "permit_number" }, { value: "CAL-OFFICE", version: 2 })]),
      );
    writeSchemaCardValueMock.mockRejectedValueOnce(conflict()).mockResolvedValue({
      outcome: "created",
      value: {},
    } as never);

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.clear(screen.getByTestId("schema-field-input-permit_number"));
    await user.type(screen.getByTestId("schema-field-input-permit_number"), "CAL-MINE");
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    // The other person's value is read back off the record, never assumed.
    const panel = await screen.findByTestId("schema-field-conflict-permit_number");
    expect(panel).toHaveTextContent("CAL-OFFICE");
    expect(panel).toHaveTextContent("CAL-MINE");
    expect(screen.queryByLabelText(/what are you correcting/i)).not.toBeInTheDocument();

    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    await waitFor(() => expect(writeSchemaCardValueMock).toHaveBeenCalledTimes(2));
    expect(writeSchemaCardValueMock.mock.calls[1]?.[1]).toMatchObject({
      expectedVersion: 2,
      value: "CAL-MINE",
      basedOnValueRevisionId: null,
      correctionReason: null,
    });
  });

  it("makes an evidence-classed field state what it is correcting, and keeps both values", async () => {
    const user = userEvent.setup();
    const evidenceField = {
      field_key: "deck_condition",
      label: "Deck condition",
      evidence_class: "physical" as const,
    };
    loadSchemaCardMock
      .mockResolvedValueOnce(model([entry(evidenceField, { value: "Sound", version: 1 })]))
      .mockResolvedValueOnce(
        model([entry(evidenceField, { value: "Two soft sheets", version: 2 })]),
      )
      .mockResolvedValue(
        model([
          {
            ...entry(evidenceField, { value: "Four soft sheets", version: 3 }),
            value: {
              ...entry(evidenceField, { value: "Four soft sheets", version: 3 }).value!,
              based_on_value_revision_id: "val_2",
              correction_reason: "Measured again after the tear-off",
            },
          } as SchemaCardEntry,
        ]),
      );
    writeSchemaCardValueMock.mockRejectedValueOnce(conflict()).mockResolvedValue({
      outcome: "created",
      value: {},
    } as never);

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-deck_condition"));
    await user.clear(screen.getByTestId("schema-field-input-deck_condition"));
    await user.type(screen.getByTestId("schema-field-input-deck_condition"), "Four soft sheets");
    await user.click(screen.getByTestId("schema-field-save-deck_condition"));

    // A correction, not a replacement: the reason is required before the button will work.
    const reason = await screen.findByLabelText(/what are you correcting/i);
    expect(screen.getByTestId("schema-field-save-deck_condition")).toBeDisabled();
    await user.type(reason, "Measured again after the tear-off");
    await user.click(screen.getByTestId("schema-field-save-deck_condition"));

    await waitFor(() => expect(writeSchemaCardValueMock).toHaveBeenCalledTimes(2));
    expect(writeSchemaCardValueMock.mock.calls[1]?.[1]).toMatchObject({
      expectedVersion: 2,
      value: "Four soft sheets",
      basedOnValueRevisionId: "val_2",
      correctionReason: "Measured again after the tear-off",
    });

    // The trail the server recorded is visible on the card, not only in the database.
    expect(await screen.findByTestId("schema-field-correction-deck_condition")).toHaveTextContent(
      "Corrected: Measured again after the tear-off",
    );
  });

  it("refuses to resolve a conflict against a copy this phone could not read", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock
      .mockResolvedValueOnce(
        model([entry({ field_key: "permit_number" }, { value: "CAL-1", version: 1 })]),
      )
      .mockRejectedValue(
        new ApiError({ status: 500, code: "server_error", message: "Something went wrong." }),
      );
    writeSchemaCardValueMock.mockRejectedValue(conflict());

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/reload the card/i);
    expect(screen.queryByTestId("schema-field-conflict-permit_number")).not.toBeInTheDocument();
  });
});

describe("entering a value with no signal", () => {
  it("queues it on the phone and says so, rather than losing it", async () => {
    const user = userEvent.setup();
    setOnline(false);
    loadSchemaCardMock.mockResolvedValue(
      model([entry({ field_key: "permit_number", offline_mode: "queueable" })], true),
    );
    queueSchemaCardValueMock.mockResolvedValue(queuedAction({ value: "CAL-2026-8891" }));

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.type(screen.getByTestId("schema-field-input-permit_number"), "CAL-2026-8891");
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    await waitFor(() => expect(queueSchemaCardValueMock).toHaveBeenCalled());
    // No network attempt at all: the request could not have succeeded, and trying first would
    // only have spent the crew member's time before saying the same thing.
    expect(writeSchemaCardValueMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/sends itself when you have signal/i)).toBeInTheDocument();
  });

  it("queues rather than discards when the connection drops mid-save", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock.mockResolvedValue(
      model([entry({ field_key: "permit_number", offline_mode: "queueable" })]),
    );
    writeSchemaCardValueMock.mockRejectedValue(
      new ApiError({
        status: 0,
        code: "network_error",
        message: "No connection to IronWrap OS. Your saved work stays on this device.",
      }),
    );
    queueSchemaCardValueMock.mockResolvedValue(queuedAction({ value: "CAL-2026-8891" }));

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.type(screen.getByTestId("schema-field-input-permit_number"), "CAL-2026-8891");
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    await waitFor(() => expect(queueSchemaCardValueMock).toHaveBeenCalled());
    expect(await screen.findByText(/sends itself when you have signal/i)).toBeInTheDocument();
  });

  it("shows a queued value as waiting, never as the field's value", async () => {
    // A crew member who reads their own entry back as the record's value believes the office can
    // see it. Until the server answers, it is device state and the card says so.
    loadSchemaCardMock.mockResolvedValue(
      model([entry({ field_key: "permit_number" }, { value: "CAL-OLD" })], true),
    );
    pendingSchemaCardWritesMock.mockResolvedValue(
      new Map([["fld_permit_number", queuedAction({ value: "CAL-NEW" })]]),
    );

    renderCard();

    expect(await screen.findByTestId("schema-field-permit_number")).toHaveTextContent("CAL-OLD");
    expect(await screen.findByTestId("schema-field-pending-permit_number")).toHaveTextContent(
      "Waiting to send: CAL-NEW",
    );
  });

  it("points a stuck entry at office review instead of inviting another try", async () => {
    loadSchemaCardMock.mockResolvedValue(model([entry({ field_key: "permit_number" })], true));
    pendingSchemaCardWritesMock.mockResolvedValue(
      new Map([
        [
          "fld_permit_number",
          { ...queuedAction({ value: "CAL-NEW" }), state: "needs_attention" as const },
        ],
      ]),
    );

    renderCard();

    expect(await screen.findByTestId("schema-field-pending-permit_number")).toHaveTextContent(
      /office review/i,
    );
  });

  it("says a field an administrator marked online-only needs a connection", async () => {
    setOnline(false);
    loadSchemaCardMock.mockResolvedValue(
      model([entry({ field_key: "signed_off_by", offline_mode: "online_only" })], true),
    );

    renderCard();

    expect(
      await screen.findByText(/needs a connection before it can be changed/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("schema-field-edit-signed_off_by")).not.toBeInTheDocument();
  });
});

describe("a card whose refresh fails after the crew already has it", () => {
  it("keeps the fields and the entry in progress instead of replacing them with a retry panel", async () => {
    const user = userEvent.setup();
    loadSchemaCardMock
      .mockResolvedValueOnce(model([entry({ field_key: "permit_number" }, { value: "CAL-1" })]))
      .mockRejectedValue(
        new ApiError({ status: 500, code: "server_error", message: "Something went wrong." }),
      );
    writeSchemaCardValueMock.mockResolvedValue({ outcome: "created", value: {} } as never);

    renderCard();

    await user.click(await screen.findByTestId("schema-field-edit-permit_number"));
    await user.clear(screen.getByTestId("schema-field-input-permit_number"));
    await user.type(screen.getByTestId("schema-field-input-permit_number"), "CAL-TYPED");
    await user.click(screen.getByTestId("schema-field-save-permit_number"));

    // The write succeeded; the read that followed it did not. Blowing the card away here would
    // take the crew member's own entry off the screen along with every other field.
    expect(await screen.findByText(/could not be refreshed just now/i)).toBeInTheDocument();
    expect(screen.getByTestId("schema-field-permit_number")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});
