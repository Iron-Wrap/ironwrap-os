import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { OfflineReadiness } from "./offline-readiness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("updates the save retry when connectivity changes without a parent render", () => {
  const connection = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const retry = vi.fn();
  render(
    <OfflineReadiness
      ready={false}
      saving={false}
      savedDetail="This job plan is saved on this phone."
      missingDetail="This job plan is not saved on this phone."
      onRetry={retry}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Try saving again" }));
  expect(retry).toHaveBeenCalledTimes(1);

  act(() => {
    connection.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
  });
  const offline = screen.getByRole("button", { name: "Go online to save" });
  expect(offline).toBeDisabled();
  fireEvent.click(offline);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("heading", { name: "Not ready offline" })).toBeVisible();

  act(() => {
    connection.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
  });
  const online = screen.getByRole("button", { name: "Try saving again" });
  expect(online).toBeEnabled();
  fireEvent.click(online);
  expect(retry).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("heading", { name: "Ready offline" })).not.toBeInTheDocument();
});
