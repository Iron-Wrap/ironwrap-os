// google.ts — Google Workspace layer: Gmail send + Drive job folders (Phase 2/3 spine).
//
// Auth = service account (GOOGLE_SERVICE_ACCOUNT_JSON secret) + domain-wide delegation,
// impersonating FROM_EMAIL. Live-verified 2026-07-02: token mint, Drive drives.list (all three
// shared drives), and a real Gmail send all succeeded with this exact flow.
//
// Files live in the "IW Jobs" Shared Drive (SHARED_DRIVE_ID_JOBS var): one folder per job named
// "<JN#> <Customer> (<Brand>)" with template subfolders 01–06. Payment/PII docs belong in
// IW Restricted and are NOT handled here. Credential-gated: googleConfigured() false ⇒ callers
// skip and the raw stays in R2, same pattern as before.

import { isOn } from "./core.ts";
import { adapterAuthority, assertEffectLedgerReady, runExternalEffect } from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { AppEnv } from "./app-types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";
const SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive";
// Docs scope is requested ONLY by proposal generation so existing Gmail/Drive
// flows keep minting under the already-authorized scope set. Domain-wide
// delegation must list the documents scope before generateProposalDoc works;
// until then its token mint fails and callers surface the error.
const DOCS_SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents";

export const JOB_SUBFOLDERS = [
  "01 Info & Notes", "02 Measurements & Reports", "03 Photos",
  "04 Materials & Suppliers", "05 Contract & Estimates", "06 Completion & Warranty",
] as const;

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.SHARED_DRIVE_ID_JOBS);
}

export function gmailConfigured(env: Env): boolean {
  return !!(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.FROM_EMAIL);
}

/** Sanitize a Drive name segment (no slashes; bounded). Pure. */
export function safeSegment(s: string): string {
  return s.replace(/[\\/]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
}

/** Job folder display name: JN number first (the automation key). Pure. */
export function jobFolderName(jobNumber: string, customer?: string | null, brand?: string | null): string {
  const parts = [safeSegment(jobNumber)];
  if (customer) parts.push(safeSegment(customer));
  const base = parts.join(" ");
  return brand ? `${base} (${safeSegment(brand)})` : base;
}

// ---------------------------------------------------------------- token (cached per isolate)
const cachedTokens = new Map<string, { token: string; exp: number }>();

const b64url = (data: string | Uint8Array): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** Mint (or reuse) an access token impersonating `sub` via domain-wide delegation. */
export async function googleToken(env: Env, sub: string, scopes: string = SCOPES): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `${sub}\n${scopes}`;
  const cached = cachedTokens.get(cacheKey);
  if (cached && cached.exp - 60 > now) return cached.token;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({ iss: sa.client_email, sub, scope: scopes, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`google_token: ${j.error ?? res.status} ${j.error_description ?? ""}`.slice(0, 200));
  cachedTokens.set(cacheKey, { token: j.access_token, exp: now + 3600 });
  return j.access_token;
}

// ---------------------------------------------------------------- gmail
export interface GmailSendReceipt {
  /** Gmail's provider-side acceptance identifier; it is not delivery proof. */
  providerMessageId: string;
}

async function gmailExpectedReadback(
  to: string,
  subject: string,
  html: string,
): Promise<{ to_sha256: string; subject_sha256: string; html_sha256: string }> {
  return {
    to_sha256: await sha256Hex(to.trim()),
    subject_sha256: await sha256Hex(subject),
    html_sha256: await sha256Hex(html),
  };
}

async function gmailObservedReadback(payload: unknown): Promise<{
  to_sha256: string;
  subject_sha256: string;
  html_sha256: string;
} | null> {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { id?: unknown; raw?: unknown }
    : null;
  if (typeof root?.id !== "string" || !root.id || typeof root.raw !== "string") return null;
  let message: string;
  try {
    const encoded = root.raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    message = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
  const boundary = message.indexOf("\r\n\r\n");
  if (boundary < 0) return null;
  const headerText = message.slice(0, boundary).replace(/\r\n[ \t]+/g, " ");
  const html = message.slice(boundary + 4);
  const headers = new Map(headerText.split("\r\n").map((line) => {
    const index = line.indexOf(":");
    return index < 1 ? ["", ""] : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
  }));
  const to = headers.get("to");
  const encodedSubject = headers.get("subject");
  if (!to || !encodedSubject) return null;
  const match = /^=\?UTF-8\?B\?([^?]+)\?=$/i.exec(encodedSubject);
  let subject = encodedSubject;
  if (match) {
    try {
      const binary = atob(match[1]);
      subject = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return await gmailExpectedReadback(to, subject, html);
}

/** Send one email as FROM_EMAIL (impersonated). Subject is RFC2047-encoded for non-ASCII. */
export async function sendGmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  options: { idempotencyKey?: string; taskId?: string; actorId?: string } = {},
): Promise<GmailSendReceipt> {
  assertEffectLedgerReady(env);
  const tenantId = String((env as Env & { APP_TENANT_ID?: string }).APP_TENANT_ID ?? "ironwrap");
  const actorId = options.actorId ?? "gmail-adapter";
    const request = { to, subject, html };
    const requestHash = await sha256Hex(canonicalJson(request));
    const idempotencyKey = options.idempotencyKey ?? `gmail:${to}:${requestHash}`;
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const result = await runExternalEffect(env as never, {
      tenantId,
      actor: { type: "agent", id: actorId },
      taskId: options.taskId ?? `gmail:${idempotencyKey}`,
      authority: adapterAuthority({ tenantId, provider: "gmail", action: "customer.email.send", actorId, deadlineAt, retryLimit: 1 }),
      aggregate: { type: "communication", id: idempotencyKey, version: 0 },
      intentId: idempotencyKey,
      action: "customer.email.send",
      request,
      requestHash,
      provider: "gmail",
      idempotencyKey,
      deadlineAt,
      expectedReadback: await gmailExpectedReadback(to, subject, html),
      retryLimit: 1,
      compensationPlan: {},
      correlationId: idempotencyKey,
    }, {
      async dispatch() {
        const value = await sendGmailDirect(env, to, subject, html);
        return { outcome: "accepted" as const, value, providerExternalId: value.providerMessageId, providerResponse: value };
      },
      async readback({ providerExternalId }) {
        if (!providerExternalId) return { status: "unavailable" as const, detailCode: "gmail_readback_id_missing" };
        const token = await googleToken(env, env.FROM_EMAIL);
        const query = new URLSearchParams({ format: "raw" });
        const response = await fetch(`${GMAIL}/users/me/messages/${encodeURIComponent(providerExternalId)}?${query.toString()}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.status === 404) return { status: "not_found" as const, detailCode: "gmail_readback_not_found" };
        if (!response.ok) return { status: "unavailable" as const, detailCode: `gmail_readback_${response.status}` };
        const value = await response.json() as unknown;
        const observed = await gmailObservedReadback(value);
        return observed
          ? { status: "match" as const, providerExternalId, observed }
          : { status: "conflict" as const, providerExternalId, observed: value, detailCode: "gmail_readback_conflict" };
      },
      async replay({ effect }) {
        const providerMessageId = effect.provider_external_id;
        if (!providerMessageId) throw new Error("gmail_replay_id_missing");
        const token = await googleToken(env, env.FROM_EMAIL);
        const response = await fetch(
          `${GMAIL}/users/me/messages/${encodeURIComponent(providerMessageId)}?format=raw`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        const observed = response.ok
          ? await gmailObservedReadback(await response.json())
          : null;
        const expected = await gmailExpectedReadback(to, subject, html);
        if (!observed || canonicalJson(observed) !== canonicalJson(expected)) {
          throw new Error("gmail_replay_readback_failed");
        }
        return { providerMessageId };
      },
    });
    if (result.effect.state !== "succeeded") throw new Error(result.effect.result_code ?? "gmail_effect_outcome_unknown");
    if (!result.value?.providerMessageId) throw new Error("gmail_effect_result_missing");
  return result.value;
}

async function sendGmailDirect(env: Env, to: string, subject: string, html: string): Promise<GmailSendReceipt> {
  const token = await googleToken(env, env.FROM_EMAIL);
  const subj = `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`;
  const raw = b64url([
    `From: ${env.FROM_EMAIL}`, `To: ${to}`, `Subject: ${subj}`,
    `MIME-Version: 1.0`, `Content-Type: text/html; charset=UTF-8`, ``, html,
  ].join("\r\n"));
  const res = await fetch(`${GMAIL}/users/me/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`gmail_send_${res.status}: ${(await res.text()).slice(0, 200)}`);
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error("gmail_send_invalid_receipt");
  }
  const id = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { id?: unknown }).id
    : null;
  if (typeof id !== "string" || !id.trim()) throw new Error("gmail_send_invalid_receipt");
  return { providerMessageId: id };
}

// ---------------------------------------------------------------- drive
const driveQS = "supportsAllDrives=true";

interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
}

interface DriveMaterialReadback {
  name_sha256: string;
  parent_id_sha256: string;
  mime_type: string;
  content_sha256?: string;
  template_id_sha256?: string;
}

async function driveExpectedReadback(
  name: string,
  parentId: string,
  mimeType: string,
  hashes: { contentSha256?: string; templateIdSha256?: string } = {},
): Promise<DriveMaterialReadback> {
  return {
    name_sha256: await sha256Hex(name),
    parent_id_sha256: await sha256Hex(parentId),
    mime_type: mimeType,
    ...(hashes.contentSha256 ? { content_sha256: hashes.contentSha256 } : {}),
    ...(hashes.templateIdSha256 ? { template_id_sha256: hashes.templateIdSha256 } : {}),
  };
}

async function driveFind(env: Env, token: string, q: string): Promise<DriveFile | null> {
  const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&corpora=drive&driveId=${env.SHARED_DRIVE_ID_JOBS}` +
    `&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,webViewLink)&pageSize=5`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`drive_list_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { files?: DriveFile[] };
  return j.files?.[0] ?? null;
}

async function driveCreateFolder(
  env: Env,
  token: string,
  name: string,
  parentId: string,
): Promise<{ id: string }> {
  const request = { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] };
  const requestHash = await sha256Hex(canonicalJson(request));
  const expectedReadback = await driveExpectedReadback(
    name,
    parentId,
    "application/vnd.google-apps.folder",
  );
  assertEffectLedgerReady(env);
  const tenantId = String((env as AppEnv).APP_TENANT_ID ?? "ironwrap");
    const idempotencyKey = `drive:folder:${parentId}:${requestHash}`;
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const result = await runExternalEffect(env as AppEnv, {
      tenantId,
      actor: { type: "agent", id: "google-drive-adapter" },
      taskId: `drive:folder:${parentId}`,
      authority: adapterAuthority({ tenantId, provider: "google-drive", action: "drive.folder.create", actorId: "google-drive-adapter", deadlineAt, retryLimit: 1 }),
      aggregate: { type: "drive_folder", id: parentId, version: 0 },
      intentId: idempotencyKey,
      action: "drive.folder.create",
      request,
      requestHash,
      provider: "google-drive",
      idempotencyKey,
      deadlineAt,
      expectedReadback,
      retryLimit: 1,
      compensationPlan: {},
      correlationId: idempotencyKey,
    }, {
      async dispatch() {
        const response = await fetch(`${DRIVE}/files?${driveQS}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          await response.text();
          return { outcome: "rejected" as const, detailCode: `drive_mkdir_${response.status}` };
        }
        const value = await response.json() as { id?: unknown; name?: unknown };
        if (typeof value.id !== "string" || !value.id) {
          return { outcome: "accepted" as const, value, detailCode: "drive_mkdir_invalid_receipt", providerResponse: value };
        }
        return { outcome: "accepted" as const, value: { id: value.id }, providerExternalId: value.id, providerResponse: value };
      },
      async readback({ providerExternalId }) {
        return await driveReadback(token, providerExternalId, expectedReadback);
      },
      async replay({ effect }) {
        return await replayDriveFile(
          token,
          effect.provider_external_id,
          expectedReadback,
        );
      },
    });
    if (result.effect.state !== "succeeded" || !result.value?.id) {
      throw new Error(result.effect.result_code ?? "drive_mkdir_outcome_unknown");
    }
  return result.value as { id: string };
}

const esc = (s: string) => s.replace(/'/g, "\\'");

/**
 * Find the job folder by JN number prefix, or create it (+ the 01–06 template) at the drive root.
 * Idempotent: name search first, template subfolders created only when missing.
 */
export async function ensureJobFolder(
  env: Env, jobNumber: string, customer?: string | null, brand?: string | null,
): Promise<{ id: string; name: string; created: boolean }> {
  const token = await googleToken(env, env.FROM_EMAIL);
  const root = env.SHARED_DRIVE_ID_JOBS;
  const jn = safeSegment(jobNumber);
  const existing = await driveFind(env, token,
    `'${root}' in parents and mimeType='application/vnd.google-apps.folder' and name contains '${esc(jn)}' and trashed=false`);
  const folder = existing ?? await driveCreateFolder(env, token, jobFolderName(jobNumber, customer, brand), root);
  for (const sub of JOB_SUBFOLDERS) await ensureSubfolder(env, token, folder.id, sub);
  return { id: folder.id, name: existing?.name ?? jobFolderName(jobNumber, customer, brand), created: !existing };
}

// ---------------------------------------------------------------- docs (proposal generation)
//
// Proposals are Google Docs copied from a tenant template and merged via
// replaceAllText over {{placeholder}} tokens. The template Doc id is tenant
// data (config/Frappe), not code. This replaces hand-built PDF generation:
// the merged Doc lives in the job's "05 Contract & Estimates" subfolder where
// the rest of the filing pipeline already looks.

const MAX_DOC_VALUE_CHARS = 5000;

/** Merge-safe scalar: control chars stripped (tab/newline kept), bounded. Pure. */
export function sanitizeDocValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").slice(0, MAX_DOC_VALUE_CHARS);
}

/** Docs batchUpdate requests replacing every {{key}} with its sanitized value. Pure. */
export function docsReplaceRequests(
  replacements: Record<string, string | number | null | undefined>,
): Array<{ replaceAllText: { containsText: { text: string; matchCase: true }; replaceText: string } }> {
  return Object.entries(replacements).map(([key, value]) => ({
    replaceAllText: {
      containsText: { text: `{{${key}}}`, matchCase: true as const },
      replaceText: sanitizeDocValue(value),
    },
  }));
}

/** Proposal Doc display name: JN number first, matching job-folder convention. Pure. */
export function proposalDocName(jobNumber: string, title?: string | null): string {
  const base = `${safeSegment(jobNumber)} Proposal`;
  return title ? `${base} - ${safeSegment(title)}` : base;
}

export interface ProposalDocReceipt {
  docId: string;
  url: string | null;
  folderId: string;
}

/**
 * Copy the tenant proposal template into the job's "05 Contract & Estimates"
 * subfolder and merge {{placeholders}}. Needs the documents scope authorized
 * for domain-wide delegation; a missing grant fails the token mint here and
 * never disturbs Gmail/Drive flows on the standard scope set.
 */
export async function generateProposalDoc(env: Env, input: {
  jobNumber: string;
  customer?: string | null;
  brand?: string | null;
  templateDocId: string;
  title?: string | null;
  replacements: Record<string, string | number | null | undefined>;
}): Promise<ProposalDocReceipt> {
  const token = await googleToken(env, env.FROM_EMAIL, DOCS_SCOPES);
  const jobFolder = await ensureJobFolder(env, input.jobNumber, input.customer, input.brand);
  const contractFolder = await driveFind(env, token,
    `'${jobFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and name='05 Contract & Estimates' and trashed=false`);
  const parentId = contractFolder?.id ?? jobFolder.id;

  const copyRequest = { name: proposalDocName(input.jobNumber, input.title), parents: [parentId] };
  assertEffectLedgerReady(env);
  const copied = await driveCopyFile(env, token, input.templateDocId, parentId, copyRequest);
  if (!copied.id) throw new Error("docs_copy_invalid_receipt");

  const requests = docsReplaceRequests(input.replacements);
  if (requests.length) {
    await driveMergeDoc(env, token, copied.id, requests);
  }
  return { docId: copied.id, url: copied.webViewLink ?? null, folderId: parentId };
}

async function ensureSubfolder(env: Env, token: string, parentId: string, name: string): Promise<string> {
  const found = await driveFind(env, token,
    `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${esc(name)}' and trashed=false`);
  if (found) return found.id;
  return (await driveCreateFolder(env, token, name, parentId)).id;
}

async function driveCopyFileDirect(
  token: string,
  templateDocId: string,
  request: {
    name: string;
    parents: string[];
    appProperties: Record<string, string>;
  },
): Promise<{ id: string; webViewLink?: string }> {
  const response = await fetch(`${DRIVE}/files/${encodeURIComponent(templateDocId)}/copy?${driveQS}&fields=id,webViewLink`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`docs_copy_${response.status}: ${(await response.text()).slice(0, 200)}`);
  const value = await response.json() as { id?: unknown; webViewLink?: unknown };
  if (typeof value.id !== "string" || !value.id) throw new Error("docs_copy_invalid_receipt");
  return { id: value.id, webViewLink: typeof value.webViewLink === "string" ? value.webViewLink : undefined };
}

async function driveCopyFile(
  env: Env,
  token: string,
  templateDocId: string,
  parentId: string,
  request: { name: string; parents: string[] },
): Promise<{ id: string; webViewLink?: string }> {
  const tenantId = String((env as AppEnv).APP_TENANT_ID ?? "ironwrap");
  const templateIdSha256 = await sha256Hex(templateDocId);
  const providerRequest = {
    ...request,
    appProperties: { ironwrap_template_id_sha256: templateIdSha256 },
  };
  const effectRequest = { templateDocId, ...providerRequest };
  const requestHash = await sha256Hex(canonicalJson(effectRequest));
  const expectedReadback = await driveExpectedReadback(
    request.name,
    parentId,
    "application/vnd.google-apps.document",
    { templateIdSha256 },
  );
  const idempotencyKey = `drive:copy:${templateDocId}:${parentId}:${requestHash}`;
  const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const result = await runExternalEffect(env as AppEnv, {
    tenantId,
    actor: { type: "agent", id: "google-drive-adapter" },
    taskId: `drive:copy:${templateDocId}`,
    authority: adapterAuthority({ tenantId, provider: "google-drive", action: "drive.file.copy", actorId: "google-drive-adapter", deadlineAt, retryLimit: 1 }),
    aggregate: { type: "drive_file", id: templateDocId, version: 0 },
    intentId: idempotencyKey,
    action: "drive.file.copy",
    request: effectRequest,
    requestHash,
    provider: "google-drive",
    idempotencyKey,
    deadlineAt,
      expectedReadback,
    retryLimit: 1,
    compensationPlan: {},
    correlationId: idempotencyKey,
  }, {
    async dispatch() {
      const value = await driveCopyFileDirect(token, templateDocId, providerRequest);
      return { outcome: "accepted" as const, value, providerExternalId: value.id, providerResponse: value };
    },
      async readback({ providerExternalId }) {
      return await driveReadback(token, providerExternalId, expectedReadback);
    },
    async replay({ effect }) {
      return await replayDriveFile(token, effect.provider_external_id, expectedReadback);
    },
  });
  if (result.effect.state !== "succeeded" || !result.value?.id) throw new Error(result.effect.result_code ?? "docs_copy_outcome_unknown");
  return result.value;
}

async function driveMergeDocDirect(
  token: string,
  docId: string,
  requests: Array<{ replaceAllText: { containsText: { text: string; matchCase: true }; replaceText: string } }>,
): Promise<void> {
  const response = await fetch(`${DOCS}/documents/${encodeURIComponent(docId)}:batchUpdate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) throw new Error(`docs_merge_${response.status}: ${(await response.text()).slice(0, 200)}`);
}

async function driveMergeDoc(
  env: Env,
  token: string,
  docId: string,
  requests: Array<{ replaceAllText: { containsText: { text: string; matchCase: true }; replaceText: string } }>,
): Promise<void> {
  const tenantId = String((env as AppEnv).APP_TENANT_ID ?? "ironwrap");
  const mergeSha256 = await sha256Hex(canonicalJson(requests));
  const requestHash = await sha256Hex(canonicalJson({ docId, requests }));
  const idempotencyKey = `google-docs:merge:${docId}:${requestHash}`;
  const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const result = await runExternalEffect(env as AppEnv, {
    tenantId,
    actor: { type: "agent", id: "google-docs-adapter" },
    taskId: `google-docs:merge:${docId}`,
    authority: adapterAuthority({ tenantId, provider: "google-docs", action: "docs.document.merge", actorId: "google-docs-adapter", deadlineAt, retryLimit: 1 }),
    aggregate: { type: "google_document", id: docId, version: 0 },
    intentId: idempotencyKey,
    action: "docs.document.merge",
    request: { docId, requests },
    requestHash,
    provider: "google-docs",
    idempotencyKey,
    deadlineAt,
    expectedReadback: { documentId: docId, merge_sha256: mergeSha256 },
    retryLimit: 1,
    compensationPlan: {},
    correlationId: idempotencyKey,
  }, {
    async dispatch() {
      await driveMergeDocDirect(token, docId, requests);
      return { outcome: "accepted" as const, value: true, providerExternalId: docId };
    },
    async readback({ providerExternalId }) {
      return await docsMergeReadback(token, providerExternalId, requests, mergeSha256);
    },
    async replay({ effect }) {
      const readback = await docsMergeReadback(token, effect.provider_external_id, requests, mergeSha256);
      if (readback.status !== "match") throw new Error(readback.detailCode ?? "docs_merge_replay_failed");
      return true;
    },
  });
  if (result.effect.state !== "succeeded") throw new Error(result.effect.result_code ?? "docs_merge_outcome_unknown");
}

async function docsMergeReadback(
  token: string,
  providerExternalId: string | null,
  requests: Array<{
    replaceAllText: {
      containsText: { text: string; matchCase: true };
      replaceText: string;
    };
  }>,
  mergeSha256: string,
): Promise<{
  status: "match" | "conflict" | "unavailable" | "not_found";
  providerExternalId?: string;
  observed?: unknown;
  detailCode?: string;
}> {
  if (!providerExternalId)
    return { status: "unavailable", detailCode: "docs_merge_id_missing" };
  try {
    const response = await fetch(
      `${DOCS}/documents/${encodeURIComponent(providerExternalId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (response.status === 404)
      return {
        status: "not_found",
        detailCode: "docs_merge_readback_not_found",
      };
    if (!response.ok)
      return {
        status: "unavailable",
        detailCode: `docs_merge_readback_${response.status}`,
      };
    const value = (await response.json()) as { documentId?: unknown };
    const text = googleDocumentText(value);
    const replacementsApplied =
      text !== null &&
      requests.every(
        ({ replaceAllText }) =>
          !text.includes(replaceAllText.containsText.text) &&
          (!replaceAllText.replaceText ||
            text.includes(replaceAllText.replaceText)),
      );
    const observed = {
      documentId: value.documentId,
      merge_sha256: replacementsApplied ? mergeSha256 : null,
    };
    return value.documentId === providerExternalId && replacementsApplied
      ? { status: "match", providerExternalId, observed }
      : {
          status: "conflict",
          providerExternalId,
          observed,
          detailCode: "docs_merge_readback_conflict",
        };
  } catch {
    return {
      status: "unavailable",
      detailCode: "docs_merge_readback_unavailable",
    };
  }
}

function googleDocumentText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chunks: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const row = node as Record<string, unknown>;
    const textRun = row.textRun;
    if (
      textRun &&
      typeof textRun === "object" &&
      !Array.isArray(textRun) &&
      typeof (textRun as Record<string, unknown>).content === "string"
    ) {
      chunks.push((textRun as Record<string, string>).content);
    }
    Object.values(row).forEach(visit);
  };
  visit(value);
  return chunks.join("");
}

async function driveReadback(
  token: string,
  providerExternalId: string | null,
  expected: DriveMaterialReadback,
): Promise<{ status: "match" | "conflict" | "unavailable" | "not_found"; providerExternalId?: string; observed?: unknown; detailCode?: string }> {
  if (!providerExternalId) return { status: "unavailable", detailCode: "drive_readback_id_missing" };
  try {
    const response = await fetch(`${DRIVE}/files/${encodeURIComponent(providerExternalId)}?${driveQS}&fields=id,name,parents,mimeType,trashed,webViewLink,appProperties`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return { status: "not_found", detailCode: "drive_readback_not_found" };
    if (!response.ok) return { status: "unavailable", detailCode: `drive_readback_${response.status}` };
    const value = await response.json() as {
      id?: unknown;
      name?: unknown;
      parents?: unknown;
      mimeType?: unknown;
      trashed?: unknown;
      webViewLink?: unknown;
      appProperties?: unknown;
    };
    const parentId = Array.isArray(value.parents) && value.parents.length === 1 && typeof value.parents[0] === "string"
      ? value.parents[0]
      : null;
    const appProperties = value.appProperties && typeof value.appProperties === "object" && !Array.isArray(value.appProperties)
      ? value.appProperties as Record<string, unknown>
      : {};
    if (value.id !== providerExternalId || typeof value.name !== "string" || !parentId || typeof value.mimeType !== "string" || value.trashed === true) {
      return { status: "conflict", providerExternalId, observed: value, detailCode: "drive_readback_conflict" };
    }
    const observed = {
      id: value.id,
      name_sha256: await sha256Hex(value.name),
      parent_id_sha256: await sha256Hex(parentId),
      mime_type: value.mimeType,
      web_view_link: typeof value.webViewLink === "string" ? value.webViewLink : null,
      ...(typeof appProperties.ironwrap_content_sha256 === "string" ? { content_sha256: appProperties.ironwrap_content_sha256 } : {}),
      ...(typeof appProperties.ironwrap_template_id_sha256 === "string" ? { template_id_sha256: appProperties.ironwrap_template_id_sha256 } : {}),
    };
    const projected = Object.fromEntries(Object.keys(expected).map((key) => [key, observed[key as keyof typeof observed]]));
    return canonicalJson(expected) === canonicalJson(projected)
      ? { status: "match", providerExternalId, observed }
      : { status: "conflict", providerExternalId, observed, detailCode: "drive_readback_conflict" };
  } catch {
    return { status: "unavailable", detailCode: "drive_readback_unavailable" };
  }
}

async function replayDriveFile(
  token: string,
  providerExternalId: string | null,
  expected: DriveMaterialReadback,
): Promise<{ id: string; webViewLink?: string }> {
  const readback = await driveReadback(token, providerExternalId, expected);
  if (readback.status !== "match" || !providerExternalId || !readback.observed || typeof readback.observed !== "object" || Array.isArray(readback.observed)) {
    throw new Error(readback.detailCode ?? "drive_replay_readback_failed");
  }
  const webViewLink = (readback.observed as { web_view_link?: unknown }).web_view_link;
  return { id: providerExternalId, ...(typeof webViewLink === "string" ? { webViewLink } : {}) };
}

export interface UploadResult { name: string; webUrl?: string; driveFileId?: string; error?: string }
export interface FiledBatch { folderId: string; folderUrl: string; files: UploadResult[] }

const DRIVE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

function driveIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!DRIVE_IDEMPOTENCY_KEY.test(value)) throw new Error("drive_invalid_idempotency_key");
  return value;
}

/** Upload files into a job's template subfolder (e.g. "03 Photos"). One bad file never sinks the batch. */
export async function fileToJobFolder(
  env: Env, jobNumber: string, subfolder: (typeof JOB_SUBFOLDERS)[number],
  files: Array<{ name: string; bytes: ArrayBuffer; contentType: string; idempotencyKey?: string }>,
): Promise<FiledBatch> {
  assertEffectLedgerReady(env);
  const token = await googleToken(env, env.FROM_EMAIL);
  const job = await ensureJobFolder(env, jobNumber);
  const parent = await ensureSubfolder(env, token, job.id, subfolder);

  const out: UploadResult[] = [];
  for (const f of files) {
    try {
      const idempotencyKey = driveIdempotencyKey(f.idempotencyKey);
      if (idempotencyKey) {
        const existing = await driveFind(env, token,
          `'${parent}' in parents and appProperties has { key='ironwrap_intake_key' and value='${esc(idempotencyKey)}' } and trashed=false`);
        if (existing) {
          out.push({
            name: safeSegment(f.name),
            webUrl: existing.webViewLink ?? `https://drive.google.com/file/d/${existing.id}`,
            driveFileId: existing.id,
          });
          continue;
        }
      }
      const bytesHash = await hashBytes(f.bytes);
      const meta = JSON.stringify({
        name: safeSegment(f.name),
        parents: [parent],
        appProperties: {
          ironwrap_content_sha256: bytesHash,
          ...(idempotencyKey ? { ironwrap_intake_key: idempotencyKey } : {}),
        },
      });
      const j = await driveUploadThroughRuntime(env, token, parent, f, meta, bytesHash, idempotencyKey);
      out.push({ name: safeSegment(f.name), webUrl: j.webViewLink ?? `https://drive.google.com/file/d/${j.id}`, driveFileId: j.id });
    } catch (e) {
      out.push({ name: safeSegment(f.name), error: String(e) });
    }
  }
  return { folderId: job.id, folderUrl: `https://drive.google.com/drive/folders/${job.id}`, files: out };
}

async function driveUploadDirect(
  token: string,
  file: { name: string; bytes: ArrayBuffer; contentType: string },
  meta: string,
): Promise<{ id: string; webViewLink?: string }> {
  // The boundary separates untrusted report bytes from JSON metadata. It is not an auth token,
  // but must still be unpredictable so a crafted payload cannot terminate the multipart body.
  const boundary = "ironwrapbus" + crypto.randomUUID().replaceAll("-", "");
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, file.bytes, tail]);
  const response = await fetch(`${UPLOAD}/files?uploadType=multipart&${driveQS}&fields=id,webViewLink`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!response.ok) throw new Error(`drive_upload_${response.status}: ${(await response.text()).slice(0, 150)}`);
  const value = await response.json() as { id?: unknown; webViewLink?: unknown };
  if (typeof value.id !== "string" || !value.id) throw new Error("drive_upload_invalid_receipt");
  return { id: value.id, webViewLink: typeof value.webViewLink === "string" ? value.webViewLink : undefined };
}

async function driveUploadThroughRuntime(
  env: Env,
  token: string,
  parentId: string,
  file: { name: string; bytes: ArrayBuffer; contentType: string },
  meta: string,
  bytesHash: string,
  idempotencyKey: string | null,
): Promise<{ id: string; webViewLink?: string }> {
  const tenantId = String((env as AppEnv).APP_TENANT_ID ?? "ironwrap");
  const request = { parentId, name: safeSegment(file.name), contentType: file.contentType, bytesHash, meta };
  const requestHash = await sha256Hex(canonicalJson(request));
  const expectedReadback = await driveExpectedReadback(
    safeSegment(file.name),
    parentId,
    file.contentType,
    { contentSha256: bytesHash },
  );
  const businessKey = idempotencyKey
    ? `drive:upload:${idempotencyKey}`
    : `drive:upload:${parentId}:${requestHash}`;
  const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const result = await runExternalEffect(env as AppEnv, {
    tenantId,
    actor: { type: "agent", id: "google-drive-adapter" },
    taskId: `drive:upload:${parentId}`,
    authority: adapterAuthority({ tenantId, provider: "google-drive", action: "drive.file.upload", actorId: "google-drive-adapter", deadlineAt, retryLimit: 1 }),
    aggregate: { type: "drive_folder", id: parentId, version: 0 },
    intentId: businessKey,
    action: "drive.file.upload",
    request,
    requestHash,
    provider: "google-drive",
    idempotencyKey: businessKey,
    deadlineAt,
    expectedReadback,
    retryLimit: 1,
    compensationPlan: {},
    correlationId: businessKey,
  }, {
    async dispatch() {
      const value = await driveUploadDirect(token, file, meta);
      return { outcome: "accepted" as const, value, providerExternalId: value.id, providerResponse: { id: value.id } };
    },
    async readback({ providerExternalId }) {
      return await driveReadback(token, providerExternalId, expectedReadback);
    },
    async replay({ effect }) {
      return await replayDriveFile(token, effect.provider_external_id, expectedReadback);
    },
  });
  if (result.effect.state !== "succeeded" || !result.value?.id) throw new Error(result.effect.result_code ?? "drive_upload_outcome_unknown");
  return result.value;
}

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export { isOn };
