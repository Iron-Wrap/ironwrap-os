import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProofStream } from "./proof-stream";

describe("ProofStream states", () => {
  it("announces an accessible empty state without inventing proof", () => {
    render(<ProofStream items={[]} hasMore={false} loadingMore={false} onLoadMore={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "No verified proof yet" })).toBeInTheDocument();
    expect(screen.getByText(/only after the exact device action is verified/i)).toBeInTheDocument();
  });

  it("renders only a bounded virtual window for more than 1,000 proof records", () => {
    const items = Array.from({ length: 1_051 }, (_, index) => ({
      id: `proof-${index}`,
      type: "Photo",
      proof_slot: "Production",
      occurred_at: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      summary: `Photo ${index}`,
      customer_safe: false,
      source: "field",
      sync_state: "Verified",
      blocker: false,
    }));
    render(<ProofStream items={items} hasMore loadingMore={false} onLoadMore={vi.fn()} />);
    expect(screen.getByRole("feed", { name: "Job proof stream" })).toBeInTheDocument();
    expect(screen.getAllByRole("article").length).toBeLessThan(20);
    expect(screen.getByRole("button", { name: "Load older proof" })).toHaveClass("min-h-16");
  });

  it("renders proof provenance and tenant-local time without inventing media detail", () => {
    render(
      <ProofStream
        items={[
          {
            id: "proof-1",
            type: "Photo",
            proof_slot: "Production",
            occurred_at: "2026-07-10T16:00:00.000Z",
            summary: "Arrival condition",
            customer_safe: false,
            source: "field_checkin",
            sync_state: "Verified",
            blocker: false,
          },
        ]}
        hasMore={false}
        loadingMore={false}
        onLoadMore={vi.fn()}
        locale="en-CA"
        timeZone="America/Edmonton"
      />,
    );
    expect(screen.getByText(/10:00.*field_checkin.*Internal/i)).toBeVisible();
    expect(screen.queryByText(/preview|play media/i)).not.toBeInTheDocument();
  });
});
