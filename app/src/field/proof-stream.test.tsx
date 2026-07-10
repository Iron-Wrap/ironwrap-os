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
});
