import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommunicationEventDraft,
  buildCompletionPacketDraft,
  buildMarketWatchItemDraft,
  buildReviewRequestDraft,
  buildSupplierQuoteDraft,
  buildWarrantyPacketDraft,
  checkConsent,
  checkQuietHours,
  completionPacketIdForRoofJob,
  evaluateReviewStopConditions,
  marketWatchIdFor,
  reviewRequestIdForRoofJob,
  supplierQuoteIdForTakeoff,
  warrantyPacketIdForRoofJob,
} from "../src/server.mjs";

const NOW = "2026-07-08T18:00:00.000Z";

test("id helpers are deterministic", () => {
  assert.equal(completionPacketIdForRoofJob("job:ow_1"), "completion:job:ow_1");
  assert.equal(warrantyPacketIdForRoofJob("job:ow_1"), "warranty:job:ow_1");
  assert.equal(reviewRequestIdForRoofJob("job:ow_1"), "review:job:ow_1");
  assert.equal(supplierQuoteIdForTakeoff("takeoff:job:ow_1"), "quote:takeoff:job:ow_1");
  assert.equal(marketWatchIdFor("Roofr", "Instant Estimator v2!"), "watch:roofr-instant-estimator-v2");
});

test("buildCompletionPacketDraft requires photo evidence", () => {
  assert.throws(() => buildCompletionPacketDraft({ roofJobId: "job:ow_1", evidence: [] }), /completion_photo_evidence_required/);
  assert.throws(() => buildCompletionPacketDraft({
    roofJobId: "job:ow_1",
    evidence: [{ evidence_type: "Measurement Report" }],
  }), /completion_photo_evidence_required/);
  assert.throws(() => buildCompletionPacketDraft({}), /roof_job_id_required/);
});

test("buildCompletionPacketDraft stays review-gated and lists deficiencies", () => {
  const draft = buildCompletionPacketDraft({
    roofJobId: "job:ow_1",
    checkIns: [
      { name: "field:1", checkin_id: "field:1", status: "Received", photo_count: 3, submitted_at: NOW },
      { name: "field:2", checkin_id: "field:2", status: "Needs Review", photo_count: 1, submitted_at: NOW },
    ],
    evidence: [
      { name: "ev1", evidence_id: "evidence:photo:1", evidence_type: "Photo", r2_key: "raw/photos/x.json" },
      { name: "ev2", evidence_id: "evidence:m1", evidence_type: "Measurement Report" },
    ],
    nowIso: NOW,
  });
  assert.equal(draft.completion_packet_id, "completion:job:ow_1");
  assert.equal(draft.status, "Needs Review");
  assert.equal(draft.warranty_ready, 0);
  assert.match(draft.deficiency_list, /field:2/);
  const summary = JSON.parse(draft.evidence_summary_json);
  assert.equal(summary.counts.photo_evidence, 1);
  assert.equal(summary.counts.open_check_ins, 1);
});

test("buildWarrantyPacketDraft requires approved, warranty-ready completion packet", () => {
  assert.throws(() => buildWarrantyPacketDraft({}), /completion_packet_id_required/);
  assert.throws(() => buildWarrantyPacketDraft({
    completionPacket: { completion_packet_id: "completion:job:ow_1", status: "Needs Review", warranty_ready: 1, roof_job: "job:ow_1" },
  }), /completion_packet_approved_required/);
  assert.throws(() => buildWarrantyPacketDraft({
    completionPacket: { completion_packet_id: "completion:job:ow_1", status: "Approved", warranty_ready: 0, roof_job: "job:ow_1" },
  }), /warranty_readiness_required/);

  const draft = buildWarrantyPacketDraft({
    completionPacket: { completion_packet_id: "completion:job:ow_1", status: "Approved", warranty_ready: 1, roof_job: "job:ow_1" },
    materialSystem: "SnapLock Metal Roofing",
    coverageYears: 25,
    nowIso: NOW,
  });
  assert.equal(draft.warranty_packet_id, "warranty:job:ow_1");
  assert.equal(draft.status, "Needs Review");
  assert.equal(draft.coverage_years, 25);
});

test("evaluateReviewStopConditions is deterministic", () => {
  assert.deepEqual(evaluateReviewStopConditions({}), {
    eligible: false,
    reasons: ["completion_packet_not_approved", "no_payment_evidence", "no_customer_consent"],
  });
  assert.deepEqual(evaluateReviewStopConditions({
    completionPacket: { status: "Approved" },
    paymentMilestones: [
      { milestone_type: "Payment", status: "Webhook Seen" },
      { milestone_type: "Invoice", status: "Needs Review" },
    ],
    consentBasis: "express",
  }), { eligible: false, reasons: ["payment_milestone_needs_review"] });
  assert.deepEqual(evaluateReviewStopConditions({
    completionPacket: { status: "Approved" },
    paymentMilestones: [{ milestone_type: "Payment", status: "Webhook Seen" }],
    consentBasis: "express",
  }), { eligible: true, reasons: [] });
});

test("buildReviewRequestDraft blocks or allows and never sends", () => {
  const blocked = buildReviewRequestDraft({ roofJobId: "job:ow_1", nowIso: NOW });
  assert.equal(blocked.status, "Blocked");
  assert.match(blocked.eligibility_notes, /completion_packet_not_approved/);

  const eligible = buildReviewRequestDraft({
    roofJobId: "job:ow_1",
    completionPacket: { completion_packet_id: "completion:job:ow_1", status: "Approved" },
    paymentMilestones: [{ milestone_type: "Payment", status: "Webhook Seen" }],
    consentBasis: "express",
    reviewLink: "https://g.page/r/ironwrap/review",
    nowIso: NOW,
  });
  assert.equal(eligible.status, "Eligible");
  assert.notEqual(eligible.status, "Sent");
  assert.deepEqual(JSON.parse(eligible.stop_conditions_json).reasons, []);
});

test("checkConsent enforces channel rules", () => {
  assert.equal(checkConsent({ channel: "Portal" }).allowed, true);
  assert.deepEqual(checkConsent({ channel: "SMS", consentBasis: "ebr" }).reasons, ["sms_requires_express_consent"]);
  assert.equal(checkConsent({ channel: "SMS", consentBasis: "express" }).allowed, true);
  assert.equal(checkConsent({ channel: "Email", consentBasis: "existing_business_relationship" }).allowed, true);
  assert.equal(checkConsent({ channel: "Email", consentBasis: "Existing Business Relationship" }).allowed, true);
  assert.deepEqual(checkConsent({ channel: "Email" }).reasons, ["consent_basis_missing"]);
  assert.deepEqual(checkConsent({ channel: "Call", consentBasis: "scraped_list" }).reasons, ["consent_basis_insufficient"]);
});

test("checkQuietHours converts to local hour deterministically", () => {
  // 18:00 UTC at UTC-6 is noon: allowed.
  assert.deepEqual(checkQuietHours({ nowUtcIso: NOW, timezoneOffsetMinutes: -360 }), {
    ok: true, local_hour: 12, start_hour: 9, end_hour: 20,
  });
  // 04:00 UTC at UTC-6 is 22:00 local: blocked.
  assert.equal(checkQuietHours({ nowUtcIso: "2026-07-08T04:00:00.000Z", timezoneOffsetMinutes: -360 }).ok, false);
  assert.throws(() => checkQuietHours({ nowUtcIso: "not-a-date" }), /now_utc_iso_required/);
});

test("checkQuietHours reads the zone's own offset when none is given", () => {
  // Alberta keeps UTC-6 all year (tzdata 2026c and later): 02:30 UTC in January is 20:30 there,
  // past the 20:00 end, where the retired winter UTC-7 would have read 19:30 and allowed it.
  assert.deepEqual(checkQuietHours({ nowUtcIso: "2027-01-15T02:30:00.000Z" }), {
    ok: false, local_hour: 20, start_hour: 9, end_hour: 20,
  });
  // A zone that still changes its clocks moves with them (America/Denver: UTC-7 in winter,
  // UTC-6 in summer), so the same UTC hour lands an hour apart.
  assert.equal(checkQuietHours({ nowUtcIso: "2027-01-15T02:30:00.000Z", timeZone: "America/Denver" }).local_hour, 19);
  assert.equal(checkQuietHours({ nowUtcIso: "2027-07-15T02:30:00.000Z", timeZone: "America/Denver" }).local_hour, 20);
});

test("buildCommunicationEventDraft is policy-gated and never Sent", () => {
  const allowed = buildCommunicationEventDraft({
    roofJobId: "job:ow_1",
    channel: "Email",
    consentBasis: "express",
    recipientRef: "customer@example.com",
    nowUtcIso: NOW,
    timezoneOffsetMinutes: -360,
  });
  assert.equal(allowed.policy_result, "Allowed");
  assert.equal(allowed.status, "Draft");
  assert.equal(allowed.quiet_hours_ok, 1);

  const quietBlocked = buildCommunicationEventDraft({
    roofJobId: "job:ow_1",
    channel: "Email",
    consentBasis: "express",
    recipientRef: "customer@example.com",
    nowUtcIso: "2026-07-08T04:00:00.000Z",
    timezoneOffsetMinutes: -360,
  });
  assert.equal(quietBlocked.status, "Blocked");
  assert.match(quietBlocked.policy_reasons_json, /quiet_hours_blocked/);

  const consentBlocked = buildCommunicationEventDraft({
    leadEnvelopeId: "ow_1",
    channel: "SMS",
    consentBasis: "ebr",
    recipientRef: "+15875550000",
    nowUtcIso: NOW,
    timezoneOffsetMinutes: -360,
  });
  assert.equal(consentBlocked.policy_result, "Blocked");
  assert.match(consentBlocked.policy_reasons_json, /sms_requires_express_consent/);

  // Inbound records skip the quiet-hours gate.
  const inbound = buildCommunicationEventDraft({
    roofJobId: "job:ow_1",
    channel: "Call",
    direction: "Inbound",
    consentBasis: "express",
    recipientRef: "+15875550000",
    nowUtcIso: "2026-07-08T04:00:00.000Z",
  });
  assert.equal(inbound.quiet_hours_ok, 1);

  assert.throws(() => buildCommunicationEventDraft({ channel: "Email", recipientRef: "x" }), /roof_job_or_lead_envelope_required/);
  assert.throws(() => buildCommunicationEventDraft({ channel: "Email", roofJobId: "job:ow_1" }), /recipient_ref_required/);
});

test("buildSupplierQuoteDraft requires approved takeoff and validity, computes totals", () => {
  const takeoff = {
    takeoff_id: "takeoff:job:ow_1",
    roof_job: "job:ow_1",
    status: "Approved",
    items: [
      { category: "Roof Surface", item_name: "Roof surface from roof_area", quantity: 1942.68, unit: "sqft", source_ref: "x" },
      { category: "Linear Metal", item_name: "Linear metal from ridge_length", quantity: 89, unit: "ft", source_ref: "y" },
    ],
  };
  assert.throws(() => buildSupplierQuoteDraft({ materialTakeoff: { ...takeoff, status: "Needs Review" }, validUntil: "2026-08-01" }), /material_takeoff_approved_required/);
  assert.throws(() => buildSupplierQuoteDraft({ materialTakeoff: takeoff }), /valid_until_required/);

  const draft = buildSupplierQuoteDraft({
    materialTakeoff: takeoff,
    supplier: "Metal Supply Co",
    validUntil: "2026-08-01",
    unitPrices: { "Roof surface from roof_area": 4.5 },
    nowIso: NOW,
  });
  assert.equal(draft.supplier_quote_id, "quote:takeoff:job:ow_1");
  assert.equal(draft.status, "Needs Review");
  assert.equal(draft.items[0].line_total, 8742.06);
  assert.equal(draft.items[1].unit_price, 0);
  assert.equal(draft.quote_total, 8742.06);
  assert.equal(draft.valid_until, "2026-08-01");
});

test("buildMarketWatchItemDraft opens with slug id and validated risk", () => {
  const draft = buildMarketWatchItemDraft({
    competitor: "CompanyCam",
    title: "AI voice reports",
    riskLevel: "High",
    productGate: "Gate 9 field voice/photo proof",
    nowIso: NOW,
  });
  assert.equal(draft.watch_id, "watch:companycam-ai-voice-reports");
  assert.equal(draft.status, "Open");
  assert.equal(draft.observed_at, NOW);
  assert.throws(() => buildMarketWatchItemDraft({ competitor: "X", title: "Y", riskLevel: "Critical" }), /risk_level_invalid/);
  assert.throws(() => buildMarketWatchItemDraft({ title: "Y" }), /competitor_required/);
});
