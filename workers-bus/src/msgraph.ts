// msgraph.ts — Microsoft Graph (OneDrive) file operations, keyed by the JobNimbus job number.
//
// Phase 3 storage spine (spec 02 §2B / 07): OneDrive is the file AUTHORITY, and every job's files
// live in one folder named by its JobNimbus job number, so field + office share a single home.
//
// CREDENTIAL-GATED. Needs an Azure app (application permission Files.ReadWrite.All — or
// Sites.ReadWrite.All for a SharePoint library) via MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET,
// plus ONEDRIVE_DRIVE_ID (target drive/library) and ONEDRIVE_ROOT (top folder, must pre-exist).
// With creds absent, oneDriveConfigured() is false and callers skip — the bus still stores the raw
// submission first, so nothing is lost; it files retroactively once creds are set.

const GRAPH = "https://graph.microsoft.com/v1.0";

export function oneDriveConfigured(env: Env): boolean {
  return !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.ONEDRIVE_DRIVE_ID);
}

/** Sanitize a single path segment (drop chars OneDrive/Windows reject; bound length). Pure. */
export function safeSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|#%]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
}

/** Folder path under the configured root for a job number, e.g. "IronWrap Jobs/JN-1234". Pure. */
export function jobFolderPath(root: string, jobNumber: string): string {
  const r = root ? safeSegment(root) + "/" : "";
  return r + safeSegment(jobNumber);
}

export interface UploadResult { name: string; webUrl?: string; error?: string }
export interface FiledPhotos { folderUrl: string; folderPath: string; files: UploadResult[] }

async function graphToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`ms_token_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const driveBase = (env: Env) => `${GRAPH}/drives/${env.ONEDRIVE_DRIVE_ID}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** GET-or-create the job folder under ONEDRIVE_ROOT (which must pre-exist). Idempotent. */
async function ensureFolder(env: Env, token: string, jobNumber: string): Promise<{ webUrl: string; path: string }> {
  const root = env.ONEDRIVE_ROOT || "";
  const path = jobFolderPath(root, jobNumber);
  const got = await fetch(`${driveBase(env)}/root:/${encodeURI(path)}`, { headers: auth(token) });
  if (got.ok) { const j = (await got.json()) as { webUrl: string }; return { webUrl: j.webUrl, path }; }
  if (got.status !== 404) throw new Error(`graph_folder_get_${got.status}: ${(await got.text()).slice(0, 200)}`);

  const parent = root ? `root:/${encodeURI(safeSegment(root))}:` : "root";
  const res = await fetch(`${driveBase(env)}/${parent}/children`, {
    method: "POST", headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ name: safeSegment(jobNumber), folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
  if (res.ok) { const j = (await res.json()) as { webUrl: string }; return { webUrl: j.webUrl, path }; }
  if (res.status === 409) { // created concurrently — re-read
    const re = await fetch(`${driveBase(env)}/root:/${encodeURI(path)}`, { headers: auth(token) });
    const j = (await re.json()) as { webUrl: string }; return { webUrl: j.webUrl, path };
  }
  throw new Error(`graph_folder_create_${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function uploadOne(env: Env, token: string, path: string, bytes: ArrayBuffer, contentType: string): Promise<string> {
  // Simple upload (OneDrive accepts up to 250 MB this way — fine for job-site photos).
  const res = await fetch(`${driveBase(env)}/root:/${encodeURI(path)}:/content`, {
    method: "PUT", headers: { ...auth(token), "content-type": contentType }, body: bytes,
  });
  if (!res.ok) throw new Error(`graph_upload_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { webUrl: string }).webUrl;
}

/** Ensure the job folder exists (no upload). Used when a job is minted. */
export async function ensureJobFolder(env: Env, jobNumber: string): Promise<{ webUrl: string; path: string }> {
  return ensureFolder(env, await graphToken(env), jobNumber);
}

/** Ensure the folder, then upload each file into it (one token for the whole submission). */
export async function fileJobPhotos(
  env: Env, jobNumber: string,
  files: Array<{ name: string; bytes: ArrayBuffer; contentType: string }>,
): Promise<FiledPhotos> {
  const token = await graphToken(env);
  const folder = await ensureFolder(env, token, jobNumber);
  const out: UploadResult[] = [];
  for (const f of files) {
    const name = safeSegment(f.name);
    try {
      const webUrl = await uploadOne(env, token, `${folder.path}/${name}`, f.bytes, f.contentType);
      out.push({ name, webUrl });
    } catch (e) {
      out.push({ name, error: String(e) }); // one bad file never sinks the batch
    }
  }
  return { folderUrl: folder.webUrl, folderPath: folder.path, files: out };
}
