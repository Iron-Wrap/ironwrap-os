import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Native, guard-checked preconditions for read/resolution tests. Producer tests use real routes. */
export function admitNewoFixture(db: DatabaseSync, input: {
  sessionId: string; tenant?: string; eventId?: string; eventType?: string;
  at: string; fields?: Record<string, unknown>; callback?: boolean; summary?: string;
}) {
  const tenant = input.tenant ?? "ironwrap";
  const eventId = input.eventId ?? `${input.sessionId}-event`;
  const eventType = input.eventType ?? "handoff_requested";
  const prior = db.prepare("SELECT * FROM newo_sessions WHERE session_id = ?").get(input.sessionId);
  const hash = createHash("sha256").update(`${tenant}:${eventId}`).digest("hex");
  const rawKey = `raw/newo/synthetic/${eventId}.json`;
  const fields = input.fields ?? {};
  const declared = ["requested", "failed"].includes(String(fields.handoff_status)) ? fields.handoff_status
    : eventType === "handoff_requested" ? "requested" : null;
  const phone = fields.contact_phone === undefined ? "+15875550142" : fields.contact_phone;
  const email = fields.contact_email ?? null;
  const admissionJson = JSON.stringify({ schema: "newo.admission.v1", event_id: eventId,
    session_id: input.sessionId, event_type: eventType, occurred_at: input.at,
    reported_handoff_status: declared, reported_urgency: fields.urgency ?? "routine",
    event_has_contact: phone || email ? 1 : 0 });
  db.exec("SAVEPOINT synthetic_admission");
  try {
    db.prepare(`INSERT INTO newo_event_receipts
      (event_id, session_id, event_type, payload_hash, raw_key, status, first_seen_at, last_seen_at, tenant_id, admission_json)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`)
      .run(eventId, input.sessionId, eventType, hash, rawKey, input.at, input.at, tenant, admissionJson);
    db.prepare(`INSERT INTO newo_event_admissions
      (event_id, tenant_id, session_id, event_type, payload_sha256, raw_key, occurred_at, envelope_id,
       reported_handoff_status, reported_urgency, event_has_contact,
       prior_status, prior_handoff_status, prior_urgency, prior_has_contact,
       matched_customer_id, matched_property_id, matched_roof_job_id, verification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, tenant, input.sessionId, eventType, hash, rawKey, input.at, prior?.lead_envelope_id ?? null,
        declared, fields.urgency ?? "routine", phone || email ? 1 : 0,
        prior?.status ?? null, prior?.handoff_status ?? null, prior?.urgency ?? null,
        prior?.contact_phone || prior?.contact_email ? 1 : 0,
        prior?.matched_customer_id ?? null, prior?.matched_property_id ?? null,
        prior?.matched_roof_job_id ?? null, prior?.verification_status ?? null);
    const fact = db.prepare("SELECT * FROM newo_event_admissions WHERE event_id = ?").get(eventId)!;
    const row: Record<string, unknown> = {
      session_id: input.sessionId, contact_phone: phone, contact_email: email,
      structured_json: "{}", created_at: input.at, ...fields,
      status: fact.projected_status, handoff_status: fact.effective_handoff_status,
      urgency: fact.effective_urgency, lead_envelope_id: fact.envelope_id,
      raw_key: rawKey, payload_hash: hash, updated_at: input.at, last_event_id: eventId,
    };
    if (!prior) {
      Object.assign(row, { tenant_id: tenant, tenant_binding_state: "bound",
        tenant_binding_source: "producer", tenant_binding_ref: eventId });
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO newo_sessions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map((key) => row[key]) as never[]);
    } else if (input.at >= String(prior.updated_at)) {
      const keys = Object.keys(row).filter((key) => key !== "session_id" && key !== "created_at");
      db.prepare(`UPDATE newo_sessions SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE session_id = ?`)
        .run(...keys.map((key) => row[key]) as never[], input.sessionId);
    }
    if (input.callback) {
      db.prepare(`INSERT INTO newo_callback_records
        (callback_id, tenant_id, session_id, event_id, reason, urgency, handoff_summary,
         contact_name, contact_phone, contact_email, address_line1, city, province, postal_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Synthetic Caller', ?, ?, '1 Example Street', 'Edmonton', 'AB', 'T5J 0N3')`)
        .run(`ncb_${createHash("sha256").update(`${tenant}:${input.sessionId}`).digest("hex").slice(0, 32)}`,
          tenant, input.sessionId, eventId, fact.callback_reason, fact.effective_urgency,
          input.summary ?? "Caller asked for a person.", phone, email);
    }
    db.prepare("UPDATE newo_event_receipts SET status = 'accepted', envelope_id = ?, completed_at = ? WHERE event_id = ?")
      .run(fact.envelope_id, input.at, eventId);
    db.exec("RELEASE synthetic_admission");
    return fact;
  } catch (error) {
    db.exec("ROLLBACK TO synthetic_admission; RELEASE synthetic_admission");
    throw error;
  }
}
