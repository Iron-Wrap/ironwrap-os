// jobnimbus.ts — push an envelope into JobNimbus (the CRM spine, per spec 00/03).
//
// LIVE-VERIFIED 2026-06-28 against api1:
//   • auth = `Authorization: Bearer <key>`; list = `{count,results}`; id = `jnid`;
//     `filter` param works but is eventually-consistent (~1s lag).
//   • valid record types: contact `Customer`, job `Retail` ("Lead" 400s).
//   • `source_name` must be an account-configured Lead Source — OMITTED (unknown values 400);
//     source is carried in `tags` + `description`.
//   • createContact **400s "Duplicate contact exists"** on a duplicate display_name — it does NOT
//     upsert. So we DEDUP first (bus tag → email → phone) and, on a duplicate error, fall back to
//     find-by-name, reusing the existing `jnid` instead of failing.
//   • api1 has no DELETE (soft-delete via `PUT {is_archived:true}`). The bus's D1 status is the
//     instant idempotency guard; JN search is the cross-system backstop.

import { isOn, type EnvelopeRecord } from "./core.ts";

const JN_BASE = "https://app.jobnimbus.com/api1";

export interface JnResult {
  contactId: string;
  jobId?: string;
  jobNumber?: string; // JN human job number (for the OneDrive folder), set only on a fresh job
  reused: boolean;
}

export async function pushToJobNimbus(env: Env, rec: EnvelopeRecord): Promise<JnResult> {
  if (!isOn(env.JOBNIMBUS_ENABLED)) {
    throw new Error("jobnimbus_disabled: set JOBNIMBUS_ENABLED=true once the live write path is approved");
  }
  if (!env.JOBNIMBUS_API_KEY) throw new Error("jobnimbus_no_key");

  const busTag = `bus:${rec.envelope_id}`;
  const p = safeJson(rec.payload_json);
  const brand = str(p.brand); // "ironwrap" | "iroof" — carried from the website form
  const routable = !!rec.intent_queue && rec.intent_queue !== "human_qualification";
  const tags = ["ironwrap-bus", busTag, `source:${rec.source}`]
    .concat(brand ? [`brand:${brand}`] : [])
    .concat(rec.intent_queue ? [`queue:${rec.intent_queue}`] : []);

  // 1) Dedup in priority order: this exact envelope (retry-safe) → existing person by email →
  //    by phone (mobile or home — GHL imports land in home_phone). JN itself blocks dup names.
  let contactId =
    (await searchByTerm(env, "/contacts", "tags", busTag)) ??
    (rec.contact_email ? await searchByTerm(env, "/contacts", "email", rec.contact_email) : null) ??
    (rec.contact_phone ? await searchByTerm(env, "/contacts", "mobile_phone", rec.contact_phone) : null) ??
    (rec.contact_phone ? await searchByTerm(env, "/contacts", "home_phone", rec.contact_phone) : null);
  let reused = !!contactId;

  if (contactId) {
    // Reuse the existing contact; stamp the bus tag so future retries match by tag.
    await jnFetch(env, "PUT", `/contacts/${contactId}`, { tags }).catch(() => {});
  } else {
    const [first, ...rest] = (rec.contact_name ?? "").trim().split(/\s+/).filter(Boolean);
    const displayName = rec.contact_name ?? rec.contact_phone ?? rec.contact_email ?? `Lead ${rec.envelope_id}`;
    const body: Record<string, unknown> = {
      record_type_name: env.JN_CONTACT_RECORD_TYPE || "Customer",
      status_name: env.JN_CONTACT_STATUS || "New",
      names: "many",
      is_lead: true,
      display_name: displayName,
      first_name: first || undefined,
      last_name: rest.join(" ") || undefined,
      mobile_phone: rec.contact_phone ?? undefined,
      email: rec.contact_email ?? undefined,
      address_line1: str(p.address ?? p.address1 ?? p.address_line1),
      city: str(p.city),
      state_text: str(p.province ?? p.state),
      zip: str(p.postal ?? p.postal_code ?? p.zip),
      country_name: str(p.country),
      external_id: rec.envelope_id,
      description: `Lead via ${rec.source}${rec.intent_queue ? " → " + rec.intent_queue : ""} (bus ${rec.envelope_id})`,
      tags,
    };
    try {
      const contact = await jnFetch(env, "POST", "/contacts", body);
      contactId = String(contact.jnid ?? "");
    } catch (e) {
      // JN rejects a duplicate display_name — find the existing one and reuse it.
      if (/duplicate contact/i.test(String(e))) {
        contactId = await searchByTerm(env, "/contacts", "display_name", displayName);
        reused = true;
      }
      if (!contactId) throw e;
    }
    if (!contactId) throw new Error("jobnimbus_contact_no_id");
  }

  // 2) Job for routable intents (idempotent by bus tag; unique-ish name avoids dup-name 400s).
  let jobId: string | undefined;
  let jobNumber: string | undefined;
  if (routable) {
    jobId = (await searchByTerm(env, "/jobs", "tags", busTag)) ?? undefined;
    if (!jobId) {
      const job = await jnFetch(env, "POST", "/jobs", {
        record_type_name: env.JN_JOB_RECORD_TYPE || "Retail",
        status_name: env.JN_JOB_STATUS || "Lead",
        name: `${rec.contact_name ?? "Lead"} — ${rec.source} (${rec.envelope_id.slice(-6)})`,
        related: [{ id: contactId, type: "contact" }],
        external_id: `${rec.envelope_id}:job`,
        tags: ["ironwrap-bus", busTag].concat(rec.intent_queue ? [`queue:${rec.intent_queue}`] : []),
      });
      jobId = String(job.jnid ?? "") || undefined;
      jobNumber = job.number != null ? String(job.number) : undefined; // JN job number → OneDrive folder
    }
  }
  return { contactId, jobId, jobNumber, reused };
}

/** Search a record type by a single field=value term (filter is the one search path JN supports). */
async function searchByTerm(env: Env, path: string, field: string, value: string | null): Promise<string | null> {
  if (!value) return null;
  const filter = JSON.stringify({ must: [{ term: { [field]: value } }] });
  const res = await fetch(`${JN_BASE}${path}?size=1&filter=${encodeURIComponent(filter)}`, { headers: authHeaders(env) });
  if (!res.ok) throw new Error(`jobnimbus_search_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { results?: Array<{ jnid?: string }> };
  return j.results?.[0]?.jnid ?? null;
}

async function jnFetch(env: Env, method: string, path: string, body: unknown): Promise<Record<string, any>> {
  const res = await fetch(JN_BASE + path, {
    method,
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`jobnimbus_http_${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as Record<string, any>;
}

function authHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.JOBNIMBUS_API_KEY}`, accept: "application/json" };
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
