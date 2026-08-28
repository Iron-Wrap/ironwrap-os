/**
 * Authenticated automation-recipient administration boundary (ELEC-204).
 *
 * `/api/v1/admin/automation-recipients` is what replaces `wrangler secret put
 * PIPELINE_AUTOMATION_RECIPIENTS_JSON`: the screen an owner uses to add "the shop" as a delivery
 * destination, without a developer and without the Frappe desk.
 *
 * It follows the shape the other administration surfaces already established - owner-gated before
 * any path is matched against a real row, CSRF-checked and idempotency-keyed on every mutation,
 * CAS on `expected_version`, append-only revisions readable as history. The one thing it does
 * differently is what it publishes: a destination goes IN and never comes back out. Reads carry a
 * masked form and the digest, which is enough to recognise a configured destination and not enough
 * to harvest one out of a stolen owner session.
 */

import { validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  AUTOMATION_RECIPIENT_CHANNELS,
  AutomationRecipientsError,
  automationRecipientReferences,
  automationRecipientView,
  createAutomationRecipient,
  getAutomationRecipient,
  listAutomationRecipientRevisions,
  listAutomationRecipients,
  retireAutomationRecipient,
  reviseAutomationRecipient,
  type AutomationRecipientActor,
} from "./automation-recipients.ts";

export const AUTOMATION_RECIPIENTS_ROOT = "/api/v1/admin/automation-recipients";
const RECIPIENT_ROUTE = /^\/api\/v1\/admin\/automation-recipients\/([^/]+)$/;
const RECIPIENT_RETIRE_ROUTE = /^\/api\/v1\/admin\/automation-recipients\/([^/]+)\/retire$/;
const RECIPIENT_REVISIONS_ROUTE = /^\/api\/v1\/admin\/automation-recipients\/([^/]+)\/revisions$/;
const MAX_BODY_BYTES = 8 * 1024;

export async function handleAutomationRecipientRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path !== AUTOMATION_RECIPIENTS_ROOT && !path.startsWith(`${AUTOMATION_RECIPIENTS_ROOT}/`))
    return null;

  // Authority first and once, before a path is matched against a row, so a non-owner cannot map
  // the tenant's recipients by probing which ids answer 404 and which answer 403.
  if (auth.session.role !== "owner")
    return json({ error: "automation_recipient_admin_forbidden" }, 403);

  try {
    if (path === AUTOMATION_RECIPIENTS_ROOT) return await recipientsRoot(req, env, auth, now);
    const revisions = path.match(RECIPIENT_REVISIONS_ROUTE);
    if (revisions) return await recipientRevisions(req, env, auth, revisions[1] ?? "");
    const retire = path.match(RECIPIENT_RETIRE_ROUTE);
    if (retire) return await recipientRetire(req, env, auth, retire[1] ?? "", now);
    const recipient = path.match(RECIPIENT_ROUTE);
    if (recipient) return await recipientRecord(req, env, auth, recipient[1] ?? "", now);
  } catch (error) {
    return domainFailure(error);
  }
  return json({ error: "not_found" }, 404);
}

async function recipientsRoot(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  now: Date,
): Promise<Response> {
  if (req.method === "GET") {
    const records = await listAutomationRecipients(env, auth.session.tenant_id);
    return json({
      version: 1,
      catalog: { channels: [...AUTOMATION_RECIPIENT_CHANNELS] },
      recipients: records.map(automationRecipientView),
    });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await createAutomationRecipient(env, {
    tenantId: auth.session.tenant_id,
    recipientRef: mutation.body.recipient_ref,
    label: mutation.body.label,
    channel: mutation.body.channel,
    destination: mutation.body.destination,
    actor: sessionActor(auth),
    idempotencyKey: mutation.idempotencyKey,
  }, now);
  return json(
    { outcome: result.kind, recipient: automationRecipientView(result.recipient) },
    result.kind === "created" ? 201 : 200,
  );
}

async function recipientRecord(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedRecipientId: string,
  now: Date,
): Promise<Response> {
  const recipientId = decoded(encodedRecipientId);
  if (!recipientId) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const record = await getAutomationRecipient(env, auth.session.tenant_id, recipientId);
    if (!record) return json({ error: "not_found" }, 404);
    return json({
      recipient: automationRecipientView(record),
      // What a retirement would strand, published on the read so the screen can warn before the
      // administrator commits to a command that will be refused.
      referenced_by: await automationRecipientReferences(
        env, auth.session.tenant_id, record.recipient_ref,
      ),
    });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await reviseAutomationRecipient(env, {
    tenantId: auth.session.tenant_id,
    recipientId,
    recipientRef: mutation.body.recipient_ref,
    label: mutation.body.label,
    channel: mutation.body.channel,
    destination: mutation.body.destination,
    expectedVersion: mutation.body.expected_version,
    actor: sessionActor(auth),
    idempotencyKey: mutation.idempotencyKey,
  }, now);
  return json({ outcome: result.kind, recipient: automationRecipientView(result.recipient) });
}

async function recipientRetire(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedRecipientId: string,
  now: Date,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const recipientId = decoded(encodedRecipientId);
  if (!recipientId) return json({ error: "not_found" }, 404);
  const mutation = await mutationInput(req, auth);
  if ("response" in mutation) return mutation.response;
  const result = await retireAutomationRecipient(env, {
    tenantId: auth.session.tenant_id,
    recipientId,
    expectedVersion: mutation.body.expected_version,
    actor: sessionActor(auth),
    idempotencyKey: mutation.idempotencyKey,
  }, now);
  return json({ outcome: result.kind, recipient: automationRecipientView(result.recipient) });
}

async function recipientRevisions(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedRecipientId: string,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const recipientId = decoded(encodedRecipientId);
  if (!recipientId) return json({ error: "not_found" }, 404);
  const current = await getAutomationRecipient(env, auth.session.tenant_id, recipientId);
  if (!current) return json({ error: "not_found" }, 404);
  const revisions = await listAutomationRecipientRevisions(
    env, auth.session.tenant_id, recipientId,
  );
  return json({
    recipient_id: recipientId,
    current_revision_id: current.revision_id,
    current_version: current.version,
    revisions: revisions.map(automationRecipientView),
  });
}

function sessionActor(auth: AuthContext): AutomationRecipientActor {
  return { role: auth.session.role, userId: auth.session.user_id };
}

async function mutationInput(
  req: Request,
  auth: AuthContext,
): Promise<{ body: Record<string, unknown>; idempotencyKey: string } | { response: Response }> {
  if (!validAppCsrf(req, auth)) return { response: json({ error: "csrf_failed" }, 403) };
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,140}$/.test(idempotencyKey))
    return { response: json({ error: "idempotency_key_required" }, 400) };
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return { response: json({ error: "payload_too_large" }, 413) };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { response: json({ error: "payload_too_large" }, 413) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { response: json({ error: "invalid_json" }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { response: json({ error: "invalid_request" }, 400) };
  const body = parsed as Record<string, unknown>;
  const allowed = new Set([
    "recipient_ref", "label", "channel", "destination", "expected_version",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    return { response: json({ error: "invalid_request" }, 400) };
  return { body, idempotencyKey };
}

function decoded(value: string): string | null {
  try {
    const result = decodeURIComponent(value).trim();
    return result.length >= 1 && result.length <= 240 ? result : null;
  } catch {
    return null;
  }
}

function domainFailure(error: unknown): Response {
  if (!(error instanceof AutomationRecipientsError)) throw error;
  const code = error.code;
  const status = code === "automation_recipient_write_failed" ? 500
    : code === "automation_recipient_not_found" ? 404
    : /conflict|_exists|_in_use|already_retired|_immutable|_limit_reached|_retired/.test(code) ? 409
    : 400;
  return json({ error: code, ...error.detail }, status);
}

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  response.headers.set("cache-control", "private, no-store");
  return response;
}
