import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";
import { Field } from "./field";
import { Input } from "./input";
import { Select } from "./select";
import { Status } from "./status";
import { Textarea } from "./textarea";

const KINDS = ["primary", "you", "secondary", "quiet", "danger"] as const;

describe("System v2 button states", () => {
  it("gives each kind its own role colours and keeps the two signals to you and held", () => {
    render(
      <>
        {KINDS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        <Button variant="held">held</Button>
      </>,
    );
    const button = (name: string) => screen.getByRole("button", { name });
    expect(button("primary")).toHaveClass("bg-primary", "active:bg-control-fill-pressed");
    expect(button("you")).toHaveClass("bg-signal-you-fill", "active:bg-signal-you-fill-pressed");
    expect(button("secondary")).toHaveClass(
      "border-control-border",
      "hover:bg-surface-selected",
      "active:bg-surface-pressed",
    );
    expect(button("quiet")).toHaveClass("hover:bg-surface-selected", "active:bg-surface-pressed");
    expect(button("danger")).toHaveClass(
      "bg-signal-held-fill",
      "active:bg-signal-held-fill-pressed",
    );
    expect(button("held").className).toBe(button("danger").className);
    // Filled kinds do not change on hover; nothing outside you and held is blue or red.
    for (const filled of ["primary", "you", "danger"])
      expect(button(filled).className).not.toMatch(/hover:/);
    for (const plain of ["primary", "secondary", "quiet"])
      expect(button(plain).className).not.toMatch(/signal-(?:you|held)/);
    for (const variant of KINDS) expect(button(variant)).toHaveAttribute("data-variant", variant);
  });

  it("recolours a disabled button and never fades it", () => {
    render(<Button disabled>Save measurement</Button>);
    const button = screen.getByRole("button", { name: "Save measurement" });
    expect(button).toBeDisabled();
    expect(button).toHaveClass(
      "disabled:not-aria-busy:text-text-tertiary",
      "disabled:not-aria-busy:border-line-hairline",
      "disabled:not-aria-busy:bg-transparent",
    );
    expect(button.className).not.toMatch(/opacity/);
  });

  it("keeps a busy button's kind, its label and the loader, and announces the wait", () => {
    const { container } = render(
      <Button variant="you" busy>
        Approve final invoice
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Approve final invoice" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    expect(button).toHaveClass("bg-signal-you-fill");
    expect(container.querySelector("svg.animate-spin")).toHaveAttribute("aria-hidden", "true");
  });

  it("sizes every button from the density tokens and keeps the target minimum", () => {
    render(
      <>
        <Button size="small">Small</Button>
        <Button>Default</Button>
        <Button size="compact">Compact</Button>
        <Button size="large">Large</Button>
        <Button size="field">Field</Button>
        <Button size="icon" aria-label="Close" />
      </>,
    );
    const button = (name: string) => screen.getByRole("button", { name });
    expect(button("Small")).toHaveClass("min-h-[var(--control-height-small)]");
    expect(button("Default")).toHaveClass("min-h-[var(--control-height)]");
    expect(button("Compact")).toHaveClass("min-h-[var(--control-height)]");
    expect(button("Large")).toHaveClass("min-h-[var(--control-height-primary)]");
    expect(button("Field")).toHaveClass("min-h-[var(--control-height-primary)]");
    expect(button("Close")).toHaveClass("size-[var(--control-height)]");
    for (const name of ["Small", "Default", "Large", "Close"])
      expect(button(name)).toHaveClass(
        "min-w-[var(--target-min)]",
        "rounded-[var(--control-radius)]",
        "border-[length:var(--control-border-width)]",
        "[&_svg]:size-[var(--control-icon)]",
      );
  });
});

describe("System v2 field states", () => {
  it("covers hover, invalid, read-only, busy and disabled on every control", () => {
    render(
      <>
        <Input aria-label="Filled" defaultValue="PMS-2213" />
        <Input aria-label="Error" invalid defaultValue="PMS-2213" />
        <Input aria-label="Read only" readOnly defaultValue="PMS-2213" />
        <Input aria-label="Checking" busy defaultValue="PMS-2213" />
        <Input aria-label="Disabled" disabled defaultValue="PMS-2213" />
        <Textarea aria-label="What happened" readOnly defaultValue="First piece is short." />
        <Select aria-label="Area" busy>
          <option>South eave</option>
        </Select>
      </>,
    );
    const field = (name: string) => screen.getByRole("textbox", { name });
    expect(field("Filled")).toHaveClass(
      "hover:bg-surface-selected",
      "border-control-border",
      "aria-invalid:border-signal-held",
    );
    expect(field("Error")).toHaveAttribute("aria-invalid", "true");
    expect(field("Read only")).toHaveAttribute("readonly");
    expect(field("Read only")).toHaveClass("bg-surface-rail", "hover:bg-surface-rail");
    expect(field("Read only")).not.toHaveClass("hover:bg-surface-selected");
    expect(field("What happened")).toHaveClass("bg-surface-rail", "resize-none");
    expect(field("Checking")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: "Area" })).toHaveAttribute("aria-busy", "true");
    expect(field("Disabled")).toBeDisabled();
    expect(field("Disabled")).toHaveClass(
      "disabled:not-aria-busy:text-text-tertiary",
      "disabled:not-aria-busy:border-line-hairline",
    );
    expect(field("Disabled").className).not.toMatch(/opacity/);
  });

  it("labels the control, describes it with help, and swaps in the error with one next step", async () => {
    const { rerender } = render(
      <Field label="Coil or part number" help="Can't scan? Type the number.">
        {(control) => <Input {...control} placeholder="like PMS-2231" />}
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Coil or part number" });
    expect(input).toHaveAccessibleDescription("Can't scan? Type the number.");
    expect(input).not.toHaveAttribute("aria-invalid");
    await userEvent.type(input, "PMS-2213");
    expect(input).toHaveValue("PMS-2213");

    rerender(
      <Field
        label="Coil or part number"
        help="Can't scan? Type the number."
        error="No coil PMS-2213 on file. Check the number on the label."
      >
        {(control) => <Input {...control} />}
      </Field>,
    );
    const invalid = screen.getByRole("textbox", { name: "Coil or part number" });
    expect(invalid).toHaveAttribute("aria-invalid", "true");
    expect(invalid).toHaveAccessibleDescription(
      "No coil PMS-2213 on file. Check the number on the label.",
    );
  });

  it("says Checking while a lookup runs and keeps the field editable", () => {
    render(
      <Field label="Coil or part number" busy>
        {(control) => <Input {...control} defaultValue="PMS-2213" />}
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Coil or part number" });
    expect(input).toHaveAttribute("aria-busy", "true");
    expect(input).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking…");
    expect(input).toHaveAccessibleDescription("Checking…");
  });

  it("shows an unknown value as words in a dashed edge, never as 0 or an empty control", () => {
    const control = vi.fn();
    render(
      <Field label="South slope area" unknown="Not measured yet" help="The measurer adds it.">
        {control}
      </Field>,
    );
    const group = screen.getByRole("group", { name: "South slope area" });
    expect(within(group).getByText("Not measured yet")).toHaveClass(
      "border-dashed",
      "border-control-placeholder",
      "text-text-secondary",
    );
    expect(group).not.toHaveTextContent(/\b0\b/);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(control).not.toHaveBeenCalled();
  });
});

describe("System v2 signal chip kinds", () => {
  it("says every AI kind in words and keeps colour to you and held", () => {
    const { container } = render(
      <>
        <Status kind="you">Needs you</Status>
        <Status kind="stopped">Held</Status>
        <Status kind="done">Done for you</Status>
        <Status kind="working">Working on it</Status>
        <Status kind="proposed">Proposed</Status>
        <Status kind="unknown">Not known yet</Status>
        <Status kind="undone">Undone by Dana Whitford</Status>
      </>,
    );
    const chip = (kind: string) => container.querySelector(`[data-status="${kind}"]`)!;
    expect(chip("you")).toHaveClass("text-signal-you", "bg-signal-you-tint");
    expect(chip("stopped")).toHaveClass("text-danger");
    for (const kind of ["done", "working", "proposed", "unknown", "undone"])
      expect(chip(kind).className).not.toMatch(/signal-(?:you|held)|danger/);
    // Proposed and unknown are told apart by edge and glyph, never by colour alone.
    expect(chip("proposed")).toHaveClass("outline-dotted");
    expect(chip("unknown")).toHaveClass("outline-dashed", "outline-control-placeholder");
    expect(chip("proposed").querySelector("svg")).toHaveAttribute("data-glyph", "proposed");
    expect(chip("working").querySelector("svg")).toHaveClass("animate-spin");
    expect(screen.getByText("Not known yet")).toBeVisible();
  });
});
