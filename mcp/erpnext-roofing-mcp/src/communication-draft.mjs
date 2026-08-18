export function checkConsent({ channel, consentBasis } = {}) {
  const basis = (consentBasis ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const express = basis === "express";
  const ebr = basis === "existing_business_relationship" || basis === "ebr";
  const reasons = [];
  if (channel === "Portal") return { allowed: true, channel, consent_basis: basis, reasons };
  if (!basis) reasons.push("consent_basis_missing");
  else if (channel === "SMS" && !express) reasons.push("sms_requires_express_consent");
  else if (!express && !ebr) reasons.push("consent_basis_insufficient");
  return { allowed: reasons.length === 0, channel, consent_basis: basis, reasons };
}

export function checkQuietHours({
  nowUtcIso,
  timezoneOffsetMinutes = -360,
  startHour = 9,
  endHour = 20,
} = {}) {
  const ts = Date.parse(nowUtcIso ?? "");
  if (!Number.isFinite(ts)) throw new Error("now_utc_iso_required");
  const localHour = new Date(ts + timezoneOffsetMinutes * 60_000).getUTCHours();
  return {
    ok: localHour >= startHour && localHour < endHour,
    local_hour: localHour,
    start_hour: startHour,
    end_hour: endHour,
  };
}

export function buildCommunicationEventDraft({
  eventId,
  roofJobId,
  leadEnvelopeId,
  channel,
  direction = "Outbound",
  template,
  consentBasis,
  bodyPreview,
  recipientRef,
  nowUtcIso,
  timezoneOffsetMinutes,
  startHour,
  endHour,
} = {}) {
  if (!channel) throw new Error("channel_required");
  if (!roofJobId && !leadEnvelopeId) throw new Error("roof_job_or_lead_envelope_required");
  if (!str(recipientRef)) throw new Error("recipient_ref_required");
  const consent = checkConsent({ channel, consentBasis });
  const quiet = direction === "Outbound"
    ? checkQuietHours({ nowUtcIso, timezoneOffsetMinutes, startHour, endHour })
    : { ok: true, local_hour: null };
  const reasons = [...consent.reasons, ...(quiet.ok ? [] : ["quiet_hours_blocked"])];
  const allowed = reasons.length === 0;

  return {
    communication_event_id: eventId ?? `comm:${slugify([channel, recipientRef, nowUtcIso].join(":"))}`,
    ...(roofJobId ? { roof_job: roofJobId } : {}),
    ...(leadEnvelopeId ? { lead_envelope: leadEnvelopeId } : {}),
    channel,
    direction,
    template: template ?? "",
    consent_basis: consent.consent_basis,
    policy_result: allowed ? "Allowed" : "Blocked",
    policy_reasons_json: JSON.stringify({ evaluated_at: nowUtcIso, allowed, reasons, quiet }, null, 2),
    quiet_hours_ok: quiet.ok ? 1 : 0,
    status: allowed ? "Draft" : "Blocked",
    body_preview: bodyPreview ?? "",
    recipient_ref: recipientRef,
    event_ts: nowUtcIso,
    notes: "Policy-gated draft record. No message is sent by this tool.",
  };
}

export async function buildCommunicationEventDraftFromArgs(args, nowIso) {
  return buildCommunicationEventDraft({
    eventId: args.communication_event_id,
    roofJobId: args.roof_job_id,
    leadEnvelopeId: args.lead_envelope_id,
    channel: args.channel,
    direction: args.direction,
    template: args.template,
    consentBasis: args.consent_basis,
    bodyPreview: args.body_preview,
    recipientRef: args.recipient_ref,
    nowUtcIso: args.now_utc_iso ?? nowIso ?? new Date().toISOString(),
    timezoneOffsetMinutes: args.timezone_offset_minutes,
    startHour: args.quiet_start_hour,
    endHour: args.quiet_end_hour,
  });
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
