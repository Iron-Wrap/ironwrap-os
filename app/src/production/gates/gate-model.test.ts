import { describe, expect, it } from "vitest";

import {
  canRecordSignedCopy,
  canReverse,
  entryInForce,
  gateSummary,
  gateView,
  gateViewFor,
  overviewClearable,
  scheduleHold,
  waiverStage,
} from "./gate-model";
import {
  accessProof,
  clearedGate,
  entry,
  gate,
  materialsProof,
  model,
  noDepositGate,
  readyToSchedule,
  request,
  safetyProof,
} from "./gate-test-fixtures";

describe("what each gate reads as", () => {
  it("counts five gates under an OD-01 contract: Deposit is a System state, not a gate", () => {
    expect(gateView(noDepositGate())).toBe("not_a_gate");
    expect(gateSummary(model("open"))).toEqual({
      total: 5,
      cleared: 0,
      waived: 0,
      blocked: 4,
      waiting: 1,
    });
  });

  it("counts Deposit as a gate where the business takes deposits", () => {
    const depositGate = gate("Deposit");
    expect(gateView(depositGate)).toBe("blocked");
    expect(gateSummary(model("open", { Deposit: depositGate })).total).toBe(6);
  });

  it("reads an open waiver request as waiting on the owner, and on the owner as waiting on you", () => {
    const own = gate("Materials", { open_waiver_requests: [request()] });
    const others = gate("Materials", {
      open_waiver_requests: [request({ is_own_request: false })],
    });
    expect(gateView(own)).toBe("waiting_on_owner");
    expect(gateViewFor(others, "owner")).toBe("waiting_on_you");
    expect(gateViewFor(others, "production")).toBe("waiting_on_owner");
  });

  it("finds the entry that holds the gate's current state", () => {
    const first = entry({ from_gate_version: 1 });
    const reversal = entry({ from_gate_version: 2, kind: "reverse", to_state: "blocked" });
    const again = entry({ from_gate_version: 3 });
    const materials = gate("Materials", {
      state: "ready",
      version: 4,
      entries: [first, reversal, again],
    });
    expect(entryInForce(materials)?.id).toBe(again.id);
    expect(entryInForce(gate("Materials"))).toBeNull();
  });
});

describe("what waits for what", () => {
  it("holds Schedule the crew for the window first, then for the blocked gates", () => {
    expect(scheduleHold(model("open"))).toEqual({ kind: "window" });
    expect(scheduleHold(model("unknown"))).toEqual({ kind: "window" });
    expect(scheduleHold(model("ended"))).toEqual({
      kind: "gates",
      gates: ["Materials", "Safety", "Access", "Weather"],
    });
    expect(scheduleHold(readyToSchedule())).toBeNull();
  });

  it("offers Safety and Access while the window holds, and every blocked gate once it ends", () => {
    expect(overviewClearable(model("open"), "production")).toEqual(["Safety", "Access"]);
    expect(overviewClearable(model("ended"), "owner")).toEqual([
      "Materials",
      "Safety",
      "Access",
      "Weather",
    ]);
    expect(overviewClearable(model("ended"), "ops")).toEqual([]);
  });

  it("lets owner or production reverse a person's clearance, never the contract's or the schedule's", () => {
    const cleared = clearedGate("Materials", materialsProof, "Prairie Coil Supply");
    expect(canReverse(cleared, "production")).toBe(true);
    expect(canReverse(cleared, "ops")).toBe(false);
    expect(canReverse(noDepositGate(), "owner")).toBe(false);
    expect(canReverse(gate("Materials"), "owner")).toBe(false);
  });

  it("draws the record step only for an owner or ops", () => {
    expect(canRecordSignedCopy("owner")).toBe(true);
    expect(canRecordSignedCopy("ops")).toBe(true);
    expect(canRecordSignedCopy("production")).toBe(false);
    expect(canRecordSignedCopy("sales")).toBe(false);
  });
});

describe("the waiver step for each viewer", () => {
  it("asks for production, approves alone for the owner, and never waives Safety", () => {
    expect(waiverStage(gate("Materials"), "production").kind).toBe("ask");
    expect(waiverStage(gate("Access"), "owner").kind).toBe("self_approve");
    expect(waiverStage(gate("Safety"), "owner").kind).toBe("not_waivable");
    expect(waiverStage(gate("Materials"), "ops").kind).toBe("read_only");
  });

  it("waits on an own request and lets the owner decide another person's", () => {
    const own = gate("Materials", { open_waiver_requests: [request()] });
    const others = gate("Materials", {
      open_waiver_requests: [request({ is_own_request: false })],
    });
    expect(waiverStage(own, "production").kind).toBe("waiting");
    expect(waiverStage(others, "owner").kind).toBe("decide");
    expect(waiverStage(others, "production").kind).toBe("waiting");
  });

  it("is read-only once the gate has moved", () => {
    const cleared = clearedGate("Access", accessProof, null);
    expect(waiverStage(cleared, "owner").kind).toBe("read_only");
    expect(waiverStage(clearedGate("Safety", safetyProof, null), "owner").kind).toBe(
      "not_waivable",
    );
  });
});
