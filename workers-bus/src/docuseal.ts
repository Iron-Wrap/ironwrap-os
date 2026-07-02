// docuseal.ts — proposal e-signature via DocuSeal (Phase 3, spec 07: DocuSeal is the e-sign path).
//
// Credential-gated: DOCUSEAL_API_KEY + DOCUSEAL_TEMPLATE_ID (+ optional DOCUSEAL_BASE_URL for a
// self-hosted instance; defaults to the DocuSeal cloud API). With no key, the proposal request is
// stored + returned as "pending" — nothing is sent. Raw is stored FIRST.
//
// NOTE: code-complete but not yet live-tested (needs a DocuSeal account/template). The submission
// shape follows DocuSeal's POST /submissions (template_id + submitters[].fields[]).

import { newEnvelopeId, parseBody } from "./core.ts";
import * as store from "./store.ts";

const DEFAULT_BASE = "https://api.docuseal.com";
const RESERVED = new Set(["job_number", "jobnumber", "job", "job_no", "jn_job", "jobnimbus_job",
  "job_id", "jobid", "name", "contact_name", "customer", "email", "contact_email"]);
const JOB_KEYS = ["job_number", "jobnumber", "job", "job_no", "jn_job", "jobnimbus_job", "job_id", "jobid"];

export interface ProposalInput {
  jobNumber: string | null;
  name: string | null;
  email: string | null;
  fields: Record<string, string>; // prefilled template fields (address, scope, total, …)
}

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(raw)) if (keys.includes(k.toLowerCase())) return raw[k];
  return undefined;
}
function asString(v: unknown): string | null {
  return (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim() : null;
}

export function docusealConfigured(env: Env): boolean {
  return !!(env.DOCUSEAL_API_KEY && env.DOCUSEAL_TEMPLATE_ID);
}

/** Parse a proposal request: job number + signer + prefilled template fields. Pure. */
export function parseProposal(raw: Record<string, unknown>): ProposalInput {
  const jobNumber = asString(pick(raw, JOB_KEYS));
  const name = asString(pick(raw, ["name", "contact_name", "customer"]));
  const email = asString(pick(raw, ["email", "contact_email"]));
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RESERVED.has(k.toLowerCase()) && (typeof v === "string" || typeof v === "number")) fields[k] = String(v);
  }
  return { jobNumber, name, email, fields };
}

/** Build the DocuSeal POST /submissions body. Pure. */
export function buildSubmission(env: Env, p: ProposalInput): Record<string, unknown> {
  return {
    template_id: Number(env.DOCUSEAL_TEMPLATE_ID),
    send_email: true,
    submitters: [{
      role: "Customer",
      email: p.email,
      name: p.name ?? undefined,
      fields: Object.entries(p.fields).map(([name, default_value]) => ({ name, default_value })),
      metadata: { job_number: p.jobNumber },
    }],
  };
}

/** POST /proposal/create handler. Auth (ADMIN_TOKEN) + body-size checked by the caller. */
export async function handleProposalCreate(env: Env, rawText: string, contentType: string | null): Promise<Response> {
  const p = parseProposal(parseBody(rawText, contentType));
  const id = newEnvelopeId();
  const now = new Date().toISOString();
  await store.putRaw(env, `raw/proposals/${now.slice(0, 10)}/${id}.json`, rawText, "application/json");

  if (!p.email) {
    await store.recordAudit(env, { automation: "proposal", trigger: "admin", envelope_id: id,
      job_number: p.jobNumber, action: "create", result: "error", error: "no_signer_email" });
    return jsonResp({ error: "no_signer_email" }, 400);
  }

  if (!docusealConfigured(env)) {
    await store.recordAudit(env, { automation: "proposal", trigger: "admin", envelope_id: id,
      job_number: p.jobNumber, action: "create", result: "ok", error: "docuseal_not_configured" });
    return jsonResp({ ok: true, status: "pending", job_number: p.jobNumber,
      note: "docuseal_not_configured — request stored; will send once DocuSeal creds are set" });
  }

  const base = env.DOCUSEAL_BASE_URL || DEFAULT_BASE;
  const res = await fetch(`${base}/submissions`, {
    method: "POST",
    headers: { "X-Auth-Token": env.DOCUSEAL_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(buildSubmission(env, p)),
  });
  if (!res.ok) {
    const err = `docuseal_${res.status}`;
    await store.recordAudit(env, { automation: "proposal", trigger: "admin", envelope_id: id,
      job_number: p.jobNumber, action: "create", result: "error", error: `${err}: ${(await res.text()).slice(0, 200)}` });
    return jsonResp({ error: err }, 502);
  }
  const data = (await res.json()) as Array<{ id?: number; slug?: string; embed_src?: string }>;
  const first = Array.isArray(data) ? data[0] : undefined;
  await store.recordAudit(env, { automation: "proposal", trigger: "admin", envelope_id: id,
    job_number: p.jobNumber, target_ids: first?.slug ? `docuseal:${first.slug}` : null,
    action: "sent", result: "ok" });
  return jsonResp({ ok: true, status: "sent", job_number: p.jobNumber, sign_url: first?.embed_src ?? null, submitters: data });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
