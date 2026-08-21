import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublicEstimatePage } from "./public-estimate-page";

const config = {
  enabled: true,
  turnstile_site_key: null,
  range_available: false,
  disclaimer:
    "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.",
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
  await user.selectOptions(screen.getByLabelText("Province"), province);
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
    await user.click(screen.getByRole("button", { name: "Send estimate request" }));

    expect(screen.getByText("Enter your full name.")).toBeInTheDocument();
    expect(screen.getByText("Enter the project address.")).toBeInTheDocument();
    expect(
      screen.getByText("Enter an email address or phone number so an estimator can reach you."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveFocus();
    expect(screen.getByLabelText("Full name")).toHaveAttribute("aria-invalid", "true");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("submits a price-free estimator review request", async () => {
    const fetcher = mockFetch(
      response(config),
      response({
        accepted: true,
        envelope_id: "env_123",
        range: null,
        disclaimer: config.disclaimer,
        review_required: true,
      }),
    );
    const user = userEvent.setup();

    await openForm();
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Send estimate request" }));

    expect(
      await screen.findByRole("heading", { name: "We got your estimate request" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("We set a price only after we check the site and its size."),
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Send estimate request" }));

    await screen.findByRole("heading", { name: "We got your estimate request" });
    expect(
      screen.getByText("iRoof will have an estimator check the site and tell you the next step."),
    ).toBeInTheDocument();
    const [, request] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(request?.body)).brand).toBe("iroof");
  });

  it("always routes a request to estimator review", async () => {
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
    await user.click(screen.getByRole("button", { name: "Send estimate request" }));

    expect(
      await screen.findByRole("heading", { name: "We got your estimate request" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("We set a price only after we check the site and its size."),
    ).toBeInTheDocument();
  });

  it("rejects a numeric range from the public API contract", async () => {
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
    await user.click(screen.getByRole("button", { name: "Send estimate request" }));

    expect(
      await screen.findByText("We could not submit your request. Please try again."),
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
    await user.click(screen.getByRole("button", { name: "Send estimate request" }));

    expect(
      await screen.findByText("Too many requests were sent. Please wait a moment and try again."),
    ).toBeInTheDocument();
  });
});
