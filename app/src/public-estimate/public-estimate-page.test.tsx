import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublicEstimatePage } from "./public-estimate-page";

const config = {
  enabled: true,
  turnstile_site_key: null,
  range_available: true,
  disclaimer:
    "This is a non-binding preliminary range. A site review and approved quote are required before final pricing, scope, scheduling, materials, or payment.",
  review_required: true,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(...responses: Response[]) {
  const queued = [...responses];
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    const next = queued.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function openForm() {
  render(<PublicEstimatePage />);
  await screen.findByRole("heading", { name: "Tell us about the exterior work." });
}

async function completeForm(user: ReturnType<typeof userEvent.setup>, province = "AB") {
  await user.type(screen.getByLabelText("Full name"), "Jordan Smith");
  await user.type(screen.getByLabelText("Project address"), "123 Example Street, Calgary");
  await user.selectOptions(screen.getByLabelText("Project province"), province);
  await user.type(screen.getByLabelText("Email"), "jordan@example.com");
  await user.selectOptions(screen.getByLabelText("What do you need help with?"), "metal_roofing");
  await user.click(
    screen.getByRole("checkbox", { name: /may contact me about this estimate request/i }),
  );
  await user.click(
    screen.getByLabelText(
      "I understand these details are used to review my request and are not a final quote.",
    ),
  );
}

describe("PublicEstimatePage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/estimate");
    vi.unstubAllGlobals();
  });

  it("validates the minimum safe intake before sending PII", async () => {
    const fetcher = mockFetch(response(config));
    const user = userEvent.setup();

    await openForm();
    await user.click(screen.getByRole("button", { name: "Request my non-binding range" }));

    expect(screen.getByText("Enter your full name.")).toBeInTheDocument();
    expect(screen.getByText("Enter the project address.")).toBeInTheDocument();
    expect(
      screen.getByText("Enter an email address or phone number so an estimator can reach you."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveFocus();
    expect(screen.getByLabelText("Full name")).toHaveAttribute("aria-invalid", "true");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows only a server-approved non-binding range", async () => {
    const fetcher = mockFetch(
      response(config),
      response({
        accepted: true,
        envelope_id: "env_123",
        range: { min_cad: 12000, max_cad: 18000, currency: "CAD" },
        disclaimer: config.disclaimer,
        review_required: true,
      }),
    );
    const user = userEvent.setup();

    await openForm();
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Request my non-binding range" }));

    expect(
      await screen.findByRole("heading", { name: "Your non-binding budget range" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/12,000.*18,000/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);

    const [, request] = fetcher.mock.calls[1]!;
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      brand: "ironwrap",
      service: "metal_roofing",
      contact: { name: "Jordan Smith", email: "jordan@example.com" },
      property: { address: "123 Example Street, Calgary", province: "AB" },
      consent: { contact: true, privacy: true },
      turnstile_token: "",
    });
    expect(body.client_submission_id).toMatch(/^[a-z0-9][a-z0-9-]{15,127}$/i);
    expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(body.client_submission_id);
  });

  it("pins iRoof copy and canonical brand from a fixed iRoof embed link", async () => {
    window.history.replaceState({}, "", "/estimate?brand=iroof");
    const fetcher = mockFetch(
      response(config),
      response({
        accepted: true,
        envelope_id: "env_iroof",
        range: null,
        disclaimer: config.disclaimer,
        review_required: true,
      }),
    );
    const user = userEvent.setup();

    await openForm();
    expect(screen.getByText("IROOF ALBERTA")).toBeInTheDocument();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/public/instant-estimate/config?brand=iroof");
    expect(
      screen.getByRole("checkbox", {
        name: "I agree that iRoof may contact me about this estimate request.",
      }),
    ).toBeInTheDocument();
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Request my non-binding range" }));

    await screen.findByRole("heading", { name: "An estimator will review your project" });
    expect(
      screen.getByText("We received your request. An iRoof estimator will review the property and confirm the next step."),
    ).toBeInTheDocument();
    const [, request] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(request?.body)).brand).toBe("iroof");
  });

  it("routes a request without an approved range to estimator review", async () => {
    mockFetch(
      response(config),
      response({
        accepted: true,
        envelope_id: "env_456",
        range: null,
        disclaimer: config.disclaimer,
        review_required: true,
      }),
    );
    const user = userEvent.setup();

    await openForm();
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Request my non-binding range" }));

    expect(
      await screen.findByRole("heading", { name: "An estimator will review your project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We do not generate a range when the available information cannot support one safely.",
      ),
    ).toBeInTheDocument();
  });

  it("never displays an online range for a project outside Alberta", async () => {
    const fetcher = mockFetch(
      response(config),
      response({
        accepted: true,
        envelope_id: "env_789",
        range: { min_cad: 12000, max_cad: 18000, currency: "CAD" },
        disclaimer: config.disclaimer,
        review_required: true,
      }),
    );
    const user = userEvent.setup();

    await openForm();
    await completeForm(user, "BC");
    await user.click(screen.getByRole("button", { name: "Request estimator review" }));

    expect(
      await screen.findByRole("heading", { name: "An estimator will review your project" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/12,000.*18,000/)).not.toBeInTheDocument();

    const [, request] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(request?.body)).property.province).toBe("BC");
  });

  it("renders a safe retry message for a rejected request", async () => {
    mockFetch(response(config), response({ error: "rate_limited" }, 429));
    const user = userEvent.setup();

    await openForm();
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Request my non-binding range" }));

    expect(
      await screen.findByText("Too many requests were sent. Please wait a moment and try again."),
    ).toBeInTheDocument();
  });
});
