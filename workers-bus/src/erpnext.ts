// erpnext.ts - optional Frappe/ERPNext consumer for canonical bus envelopes.

import { isOn, type EnvelopeRecord } from "./core.ts";
import type { JnResult } from "./jobnimbus.ts";

type ErpEnv = Env & {
  ERPNEXT_ENABLED?: string;
  ERPNEXT_BASE_URL?: string;
  ERPNEXT_API_KEY?: string;
  ERPNEXT_API_SECRET?: string;
  ERPNEXT_LEAD_ENVELOPE_DOCTYPE?: string;
};

export interface ErpNextResult {
  name: string;
  reused: boolean;
}

export async function pushToErpNext(
  env: Env,
  rec: EnvelopeRecord,
  jn?: JnResult,
): Promise<ErpNextResult | null> {
  const cfg = env as ErpEnv;
  if (!isOn(cfg.ERPNEXT_ENABLED)) return null;
  if (!cfg.ERPNEXT_API_KEY || !cfg.ERPNEXT_API_SECRET) throw new Error("erpnext_no_token");

  const base = normalizeBaseUrl(cfg.ERPNEXT_BASE_URL);
  const doctype = cfg.ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope";
  const doc = {
    envelope_id: rec.envelope_id,
    source: rec.source,
    contact_name: rec.contact_name ?? undefined,
    contact_phone: rec.contact_phone ?? undefined,
    contact_email: rec.contact_email ?? undefined,
    job_ref: rec.job_ref ?? undefined,
    raw_key: rec.raw_key ?? undefined,
    event_ts: rec.ts,
    status: rec.status,
    intent_queue: rec.intent_queue ?? undefined,
    payload_json: rec.payload_json,
    jobnimbus_contact_id: jn?.contactId ?? rec.jn_contact_id ?? undefined,
    jobnimbus_job_id: jn?.jobId ?? rec.jn_job_id ?? undefined,
  };

  const existing = await findByEnvelopeId(cfg, base, doctype, rec.envelope_id);
  if (existing) {
    await erpFetch(cfg, base, "PUT", `/api/resource/${enc(doctype)}/${enc(existing)}`, doc);
    return { name: existing, reused: true };
  }

  const created = await erpFetch(cfg, base, "POST", `/api/resource/${enc(doctype)}`, doc);
  const name = readName(created);
  if (!name) throw new Error("erpnext_create_no_name");
  return { name, reused: false };
}

async function findByEnvelopeId(env: ErpEnv, base: string, doctype: string, envelopeId: string): Promise<string | null> {
  const fields = encodeURIComponent(JSON.stringify(["name"]));
  const filters = encodeURIComponent(JSON.stringify([[doctype, "envelope_id", "=", envelopeId]]));
  const path = `/api/resource/${enc(doctype)}?fields=${fields}&filters=${filters}&limit_page_length=1`;
  const found = await erpFetch(env, base, "GET", path);
  const rows = Array.isArray(found.data) ? found.data as Array<{ name?: unknown }> : [];
  const name = rows[0]?.name;
  return typeof name === "string" && name ? name : null;
}

async function erpFetch(
  env: ErpEnv,
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data?: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`erpnext_http_${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json() as { data?: unknown };
}

function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("erpnext_no_base_url");
  const base = raw.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error("erpnext_bad_base_url");
  return base;
}

function readName(created: { data?: unknown }): string | null {
  const data = created.data as { name?: unknown } | undefined;
  return typeof data?.name === "string" && data.name ? data.name : null;
}

const enc = encodeURIComponent;
