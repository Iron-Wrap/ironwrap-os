/** Counts carry no contact content. Unknown legacy ownership blocks every deployment sharing D1. */
export interface NewoTenantBindingCounts {
  unbound_sessions: number;
  conflicting_sessions: number;
  unbound_receipts: number;
  conflicting_receipts: number;
  unproven_callbacks: number;
  conflicting_resolutions: number;
  missing_admission_callbacks: number;
  invalid_projections: number;
  legacy_owed_without_record: number;
}

export const NEWO_TENANT_BINDING_COUNT_KEYS = [
  "unbound_sessions", "conflicting_sessions", "unbound_receipts", "conflicting_receipts", "unproven_callbacks",
  "conflicting_resolutions", "missing_admission_callbacks", "invalid_projections", "legacy_owed_without_record",
] as const satisfies readonly (keyof NewoTenantBindingCounts)[];

export const NEWO_TENANT_BINDING_QUERY = `SELECT
  (SELECT COUNT(*) FROM newo_sessions WHERE tenant_binding_state = 'unbound') AS unbound_sessions,
  (SELECT COUNT(*) FROM newo_sessions session WHERE tenant_binding_state = 'conflict'
    OR (tenant_binding_state = 'bound' AND (tenant_id IS NULL
      OR (lead_envelope_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM envelopes envelope
        WHERE envelope.envelope_id = session.lead_envelope_id AND envelope.tenant_id = session.tenant_id
          AND ((envelope.source = 'phone' AND json_valid(envelope.payload_json)
            AND json_extract(envelope.payload_json, '$.provider') = 'newo'
            AND json_extract(envelope.payload_json, '$.session_id') = session.session_id)
            OR EXISTS (SELECT 1 FROM operating_roof_jobs job WHERE job.roof_job_id = session.matched_roof_job_id
              AND job.tenant_id = session.tenant_id AND job.source_envelope_id = envelope.envelope_id))))
      OR (tenant_binding_source = 'producer' AND NOT EXISTS (SELECT 1 FROM newo_event_admissions origin
        WHERE origin.event_id = session.tenant_binding_ref AND origin.session_id = session.session_id
          AND origin.tenant_id = session.tenant_id))
      OR (tenant_binding_source <> 'producer' AND (
        (tenant_binding_ref GLOB 'envelope:*' AND NOT EXISTS (SELECT 1 FROM envelopes origin
          WHERE origin.envelope_id = substr(session.tenant_binding_ref, 10) AND origin.tenant_id = session.tenant_id
            AND ((origin.source = 'phone' AND json_valid(origin.payload_json)
              AND json_extract(origin.payload_json, '$.provider') = 'newo'
              AND json_extract(origin.payload_json, '$.session_id') = session.session_id)
              OR EXISTS (SELECT 1 FROM operating_roof_jobs job WHERE job.roof_job_id = session.matched_roof_job_id
                AND job.tenant_id = session.tenant_id AND job.source_envelope_id = origin.envelope_id))))
        OR (tenant_binding_ref GLOB 'job:*' AND NOT EXISTS (SELECT 1 FROM operating_roof_jobs origin
          WHERE origin.roof_job_id = substr(session.tenant_binding_ref, 5) AND origin.tenant_id = session.tenant_id))))
      OR ((matched_roof_job_id IS NOT NULL OR matched_customer_id IS NOT NULL OR matched_property_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM operating_roof_jobs job
          JOIN operating_customers customer ON customer.customer_id = job.customer_id AND customer.tenant_id = job.tenant_id
          JOIN operating_properties property ON property.property_id = job.property_id AND property.tenant_id = job.tenant_id
          JOIN operating_leads lead ON lead.lead_id = job.lead_id AND lead.tenant_id = job.tenant_id
         WHERE job.roof_job_id = session.matched_roof_job_id AND job.tenant_id = session.tenant_id
           AND customer.customer_id = session.matched_customer_id AND property.property_key = session.matched_property_id
           AND session.verification_status = 'verified'
           AND NOT EXISTS (SELECT 1 FROM (SELECT job.source_envelope_id AS id
             UNION SELECT customer.source_envelope_id UNION SELECT property.source_envelope_id
             UNION SELECT lead.source_envelope_id) source
             WHERE NOT EXISTS (SELECT 1 FROM envelopes envelope WHERE envelope.envelope_id = source.id
               AND envelope.tenant_id = session.tenant_id))))))) AS conflicting_sessions,
  (SELECT COUNT(*) FROM newo_event_receipts WHERE tenant_id IS NULL) AS unbound_receipts,
  (SELECT COUNT(*) FROM newo_event_receipts receipt WHERE tenant_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM newo_sessions session WHERE session.session_id = receipt.session_id
      AND (session.tenant_binding_state <> 'bound' OR session.tenant_id IS NOT receipt.tenant_id))
    OR (status = 'accepted' AND NOT EXISTS (SELECT 1 FROM newo_sessions session WHERE session.session_id = receipt.session_id))
    OR (envelope_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM envelopes envelope
      WHERE envelope.envelope_id = receipt.envelope_id AND envelope.tenant_id = receipt.tenant_id)))) AS conflicting_receipts,
  (SELECT COUNT(*) FROM newo_callback_records callback WHERE NOT EXISTS (
    SELECT 1 FROM newo_sessions session WHERE session.session_id = callback.session_id
      AND session.tenant_id = callback.tenant_id AND session.tenant_binding_state = 'bound'
      AND (EXISTS (SELECT 1 FROM newo_event_admissions admitted
        WHERE admitted.event_id = callback.event_id AND admitted.session_id = callback.session_id
          AND admitted.tenant_id = callback.tenant_id AND admitted.callback_reason = callback.reason
          AND COALESCE(admitted.effective_urgency, 'routine') = callback.urgency)
        OR EXISTS (SELECT 1 FROM newo_event_receipts receipt
          WHERE receipt.event_id = callback.event_id AND receipt.session_id = callback.session_id
            AND receipt.tenant_id = callback.tenant_id AND receipt.status = 'accepted' AND receipt.admission_json IS NULL
            AND ((receipt.event_type = 'handoff_requested' AND callback.reason = 'callback_requested')
              OR (receipt.event_type = 'session_failed' AND callback.reason = 'session_failed')))))) AS unproven_callbacks,
  (SELECT COUNT(*) FROM newo_handoff_resolutions resolution WHERE NOT EXISTS (
    SELECT 1 FROM newo_sessions session WHERE session.session_id = resolution.session_id
      AND session.tenant_id = resolution.tenant_id AND session.tenant_binding_state = 'bound')) AS conflicting_resolutions,
  (SELECT COUNT(*) FROM newo_event_admissions admitted WHERE admitted.callback_reason IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM newo_callback_records callback
      WHERE callback.session_id = admitted.session_id AND callback.tenant_id = admitted.tenant_id)
    AND NOT EXISTS (SELECT 1 FROM newo_handoff_resolutions resolution
      WHERE resolution.session_id = admitted.session_id AND resolution.tenant_id = admitted.tenant_id)) AS missing_admission_callbacks,
  (SELECT COUNT(*) FROM newo_sessions session WHERE tenant_binding_state = 'bound' AND last_event_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM newo_event_admissions admitted WHERE admitted.event_id = session.last_event_id
      AND admitted.session_id = session.session_id AND admitted.tenant_id = session.tenant_id
      AND admitted.payload_sha256 = session.payload_hash AND admitted.raw_key = session.raw_key
      AND admitted.occurred_at = session.updated_at AND admitted.projected_status = session.status
      AND admitted.effective_handoff_status IS session.handoff_status AND admitted.effective_urgency IS session.urgency
      AND admitted.envelope_id IS session.lead_envelope_id
      AND admitted.matched_customer_id IS session.matched_customer_id
      AND admitted.matched_property_id IS session.matched_property_id
      AND admitted.matched_roof_job_id IS session.matched_roof_job_id
      AND admitted.verification_status IS session.verification_status)) AS invalid_projections,
  (SELECT COUNT(*) FROM newo_sessions session WHERE tenant_binding_state = 'bound' AND last_event_id IS NULL
    AND handoff_status IN ('requested', 'failed')
    AND NOT EXISTS (SELECT 1 FROM newo_callback_records callback WHERE callback.session_id = session.session_id
      AND callback.tenant_id = session.tenant_id)
    AND NOT EXISTS (SELECT 1 FROM newo_handoff_resolutions resolution WHERE resolution.session_id = session.session_id
      AND resolution.tenant_id = session.tenant_id)) AS legacy_owed_without_record`;

export function newoTenantBindingsReady(counts: NewoTenantBindingCounts | null | undefined): boolean {
  return !!counts && NEWO_TENANT_BINDING_COUNT_KEYS.every((key) =>
    Number.isSafeInteger(counts[key]) && counts[key] === 0);
}

export async function newoTenantBindingReadiness(env: Pick<Env, "DB">): Promise<{
  ready: boolean; counts: NewoTenantBindingCounts | null;
}> {
  try {
    const counts = await env.DB.prepare(NEWO_TENANT_BINDING_QUERY).first<NewoTenantBindingCounts>();
    return { ready: newoTenantBindingsReady(counts), counts };
  } catch { return { ready: false, counts: null }; }
}
