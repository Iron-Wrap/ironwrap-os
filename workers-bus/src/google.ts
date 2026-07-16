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

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive";

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
let cached: { token: string; exp: number; sub: string } | null = null;

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
export async function googleToken(env: Env, sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.sub === sub && cached.exp - 60 > now) return cached.token;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({ iss: sa.client_email, sub, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
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
  cached = { token: j.access_token, exp: now + 3600, sub };
  return j.access_token;
}

// ---------------------------------------------------------------- gmail
export interface GmailSendReceipt {
  /** Gmail's provider-side acceptance identifier; it is not delivery proof. */
  providerMessageId: string;
}

/** Send one email as FROM_EMAIL (impersonated). Subject is RFC2047-encoded for non-ASCII. */
export async function sendGmail(env: Env, to: string, subject: string, html: string): Promise<GmailSendReceipt> {
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

async function driveFind(env: Env, token: string, q: string): Promise<{ id: string; name: string } | null> {
  const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&corpora=drive&driveId=${env.SHARED_DRIVE_ID_JOBS}` +
    `&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name)&pageSize=5`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`drive_list_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return j.files?.[0] ?? null;
}

async function driveCreateFolder(env: Env, token: string, name: string, parentId: string): Promise<{ id: string }> {
  const res = await fetch(`${DRIVE}/files?${driveQS}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`drive_mkdir_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { id: string };
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
  if (existing) return { ...existing, created: false };

  const folder = await driveCreateFolder(env, token, jobFolderName(jobNumber, customer, brand), root);
  for (const sub of JOB_SUBFOLDERS) await driveCreateFolder(env, token, sub, folder.id);
  return { id: folder.id, name: jobFolderName(jobNumber, customer, brand), created: true };
}

async function ensureSubfolder(env: Env, token: string, parentId: string, name: string): Promise<string> {
  const found = await driveFind(env, token,
    `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${esc(name)}' and trashed=false`);
  if (found) return found.id;
  return (await driveCreateFolder(env, token, name, parentId)).id;
}

export interface UploadResult { name: string; webUrl?: string; driveFileId?: string; error?: string }
export interface FiledBatch { folderId: string; folderUrl: string; files: UploadResult[] }

/** Upload files into a job's template subfolder (e.g. "03 Photos"). One bad file never sinks the batch. */
export async function fileToJobFolder(
  env: Env, jobNumber: string, subfolder: (typeof JOB_SUBFOLDERS)[number],
  files: Array<{ name: string; bytes: ArrayBuffer; contentType: string }>,
): Promise<FiledBatch> {
  const token = await googleToken(env, env.FROM_EMAIL);
  const job = await ensureJobFolder(env, jobNumber);
  const parent = await ensureSubfolder(env, token, job.id, subfolder);

  const out: UploadResult[] = [];
  for (const f of files) {
    try {
      const meta = JSON.stringify({ name: safeSegment(f.name), parents: [parent] });
      const boundary = "ironwrapbus" + Math.random().toString(36).slice(2);
      const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: ${f.contentType}\r\n\r\n`;
      const tail = `\r\n--${boundary}--`;
      const body = new Blob([head, f.bytes, tail]);
      const res = await fetch(`${UPLOAD}/files?uploadType=multipart&${driveQS}&fields=id,webViewLink`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!res.ok) throw new Error(`drive_upload_${res.status}: ${(await res.text()).slice(0, 150)}`);
      const j = (await res.json()) as { id: string; webViewLink?: string };
      out.push({ name: safeSegment(f.name), webUrl: j.webViewLink ?? `https://drive.google.com/file/d/${j.id}`, driveFileId: j.id });
    } catch (e) {
      out.push({ name: safeSegment(f.name), error: String(e) });
    }
  }
  return { folderId: job.id, folderUrl: `https://drive.google.com/drive/folders/${job.id}`, files: out };
}

export { isOn };
