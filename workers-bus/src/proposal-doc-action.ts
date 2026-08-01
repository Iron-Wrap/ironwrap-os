// proposal-doc-action.ts - human-triggered proposal Doc generation.
//
// An estimator clicks "generate proposal" in the workbench; this handler copies
// the tenant template Doc into the job's Drive folder and merges placeholders.
// It is a HUMAN-authorized side effect, not machine authority: estimator
// permission + CSRF are required, the whole flow is config-gated on
// PROPOSAL_TEMPLATE_DOC_ID + Google credentials, and every outcome lands in the
// audit log. Replacement values are sanitized/bounded by the Docs layer; this
// layer bounds keys and count. Upstream provider errors are logged in full but
// returned as an opaque code (no URL/status echo to the browser).

import type { AppEnv, AuthContext } from "./app-types.ts";
import { validAppCsrf } from "./app-auth.ts";
import { generateProposalDoc, googleConfigured } from "./google.ts";
import { recordAudit } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REPLACEMENTS = 40;
const REPLACEMENT_KEY = /^[a-zA-Z0-9_]{1,40}$/;
const MAX_TEXT = 200;

interface ProposalDocRequest {
  jobNumber: string;
  customer: string | null;
  brand: string | null;
  title: string | null;
  replacements: Record<string, string | number>;
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

function appJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}

function boundedText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** Validate the browser payload; null on any out-of-contract shape. Pure. */
export function parseProposalDocRequest(raw: unknown): ProposalDocRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const jobNumber = boundedText(body.job_number, 160);
  if (!jobNumber) return null;
  const replacements: Record<string, string | number> = {};
  if (body.replacements !== undefined) {
    if (!body.replacements || typeof body.replacements !== "object" || Array.isArray(body.replacements)) return null;
    const entries = Object.entries(body.replacements as Record<string, unknown>);
    if (entries.length > MAX_REPLACEMENTS) return null;
    for (const [key, value] of entries) {
      if (!REPLACEMENT_KEY.test(key)) return null;
      if (typeof value === "number" && Number.isFinite(value)) replacements[key] = value;
      else if (typeof value === "string" && value.length <= 5000) replacements[key] = value;
      else return null;
    }
  }
  return {
    jobNumber,
    customer: boundedText(body.customer),
    brand: boundedText(body.brand),
    title: boundedText(body.title),
    replacements,
  };
}

export async function handleProposalDocAction(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!auth.permissions.includes("estimator:read"))
    return appJson({ error: "estimator_access_required" }, 403);
  if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);

  const templateDocId = ((env as { PROPOSAL_TEMPLATE_DOC_ID?: string }).PROPOSAL_TEMPLATE_DOC_ID ?? "").trim();
  if (!templateDocId || !googleConfigured(env))
    return appJson({ error: "proposal_doc_not_configured" }, 503);

  let parsedBody: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return appJson({ error: "payload_too_large" }, 413);
    parsedBody = JSON.parse(text);
  } catch {
    return appJson({ error: "invalid_json" }, 400);
  }
  const input = parseProposalDocRequest(parsedBody);
  if (!input) return appJson({ error: "invalid_proposal_doc_request" }, 400);

  const envelopeId = `proposal_doc:${crypto.randomUUID()}`;
  try {
    const receipt = await generateProposalDoc(env, {
      jobNumber: input.jobNumber,
      customer: input.customer,
      brand: input.brand,
      templateDocId,
      title: input.title,
      replacements: input.replacements,
    });
    await recordAudit(env, {
      automation: "proposal_doc",
      trigger: "estimator",
      envelope_id: envelopeId,
      job_number: input.jobNumber,
      target_ids: `doc:${receipt.docId}`,
      action: "generate",
      result: "ok",
      approved_by: auth.session.user_id,
    });
    return appJson({ doc_id: receipt.docId, url: receipt.url, folder_id: receipt.folderId });
  } catch (error) {
    log({ at: "proposal_doc_action", job_number: input.jobNumber, error: String(error).slice(0, 200) });
    try {
      await recordAudit(env, {
        automation: "proposal_doc",
        trigger: "estimator",
        envelope_id: envelopeId,
        job_number: input.jobNumber,
        action: "generate",
        result: "error",
        error: "proposal_doc_failed",
        approved_by: auth.session.user_id,
      });
    } catch {
      // Audit backend unavailable: the operation error above is already logged.
    }
    return appJson({ error: "proposal_doc_failed" }, 502);
  }
}
