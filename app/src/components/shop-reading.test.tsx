import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ShopReadingContext, useShopReading } from "./shop-reading";

function Page({ initial }: { initial: boolean }) {
  const [reading, setReading] = useShopReading(() => initial);
  return (
    <button type="button" onClick={() => setReading((current) => !current)}>
      {reading ? "reading" : "office"}
    </button>
  );
}

describe("useShopReading", () => {
  it("publishes the page's state to the shell and withdraws it when the page leaves", async () => {
    const publish = vi.fn();
    const view = render(
      <ShopReadingContext value={publish}>
        <Page initial={false} />
      </ShopReadingContext>,
    );
    expect(publish).toHaveBeenLastCalledWith(false);

    await userEvent.click(screen.getByRole("button", { name: "office" }));
    expect(screen.getByRole("button", { name: "reading" })).toBeInTheDocument();
    expect(publish).toHaveBeenLastCalledWith(true);

    act(() => view.unmount());
    expect(publish).toHaveBeenLastCalledWith(false);
  });

  it("still works as plain state when no shell is listening", async () => {
    render(<Page initial />);
    expect(screen.getByRole("button", { name: "reading" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "reading" }));
    expect(screen.getByRole("button", { name: "office" })).toBeInTheDocument();
  });
});
