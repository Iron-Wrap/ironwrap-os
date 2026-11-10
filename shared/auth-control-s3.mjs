import {
  AUTH_CONTROL_KEY,
  canonicalV2,
  parseCanonicalV2,
  sha256V2,
  validateControlHead,
} from "./auth-protocol-v2.mjs";

function invalid() {
  throw new Error("auth_control_unavailable");
}
const utf8 = (value) => new TextEncoder().encode(value);
const hex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, utf8(value)),
  );
}

export function controlObjectUrl(config) {
  if (
    !/^[0-9a-f]{32}$/.test(config.accountId) ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    config.key !== AUTH_CONTROL_KEY
  )
    invalid();
  return `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${AUTH_CONTROL_KEY}`;
}

// Fixed endpoint/key; no redirects, implicit retries, credential fallback or object deletion.
export async function signedControlRequest(
  config,
  method,
  body = "",
  condition = {},
  now = new Date(),
) {
  if (
    !["GET", "PUT"].includes(method) ||
    typeof config.accessKeyId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(config.accessKeyId) ||
    typeof config.secretAccessKey !== "string" ||
    config.secretAccessKey.length < 32
  )
    invalid();
  const url = new URL(controlObjectUrl(config));
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const payload = await sha256V2(body);
  const headers = new Headers({
    host: url.host,
    "x-amz-date": date,
    "x-amz-content-sha256": payload,
    "cache-control": "no-cache, no-store",
    pragma: "no-cache",
  });
  if (method === "PUT") {
    headers.set("content-type", "application/json");
    if (condition.ifNoneMatch === "*" && !condition.ifMatch)
      headers.set("if-none-match", "*");
    else if (
      typeof condition.ifMatch === "string" &&
      /^"[^"\r\n]{1,128}"$/.test(condition.ifMatch) &&
      !condition.ifNoneMatch
    )
      headers.set("if-match", condition.ifMatch);
    else invalid();
  } else if (body || Object.keys(condition).length) invalid();
  const entries = [...headers.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const signed = entries.map(([name]) => name).join(";");
  const canonical = [
    method,
    url.pathname,
    "",
    entries.map(([key, value]) => `${key}:${value.trim()}\n`).join(""),
    signed,
    payload,
  ].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha256V2(canonical)}`;
  let key = await hmac(utf8(`AWS4${config.secretAccessKey}`), day);
  for (const part of ["auto", "s3", "aws4_request"])
    key = await hmac(key, part);
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${hex(await hmac(key, toSign))}`,
  );
  return new Request(url, {
    method,
    headers,
    body: method === "PUT" ? body : undefined,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
}

async function boundedText(response) {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 65536) invalid();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(all);
}

export async function readControlObject(config, fetcher = globalThis.fetch) {
  const response = await fetcher(await signedControlRequest(config, "GET"));
  if (response.status === 404) return null;
  if (response.status !== 200) invalid();
  const etag = response.headers.get("etag");
  if (!etag || !/^"[^"\r\n]{1,128}"$/.test(etag)) invalid();
  const text = await boundedText(response);
  return {
    head: validateControlHead(parseCanonicalV2(text)),
    etag,
    bodyHash: await sha256V2(text),
  };
}

export async function putControlObject(
  config,
  head,
  condition,
  fetcher = globalThis.fetch,
) {
  const body = canonicalV2(validateControlHead(head));
  const response = await fetcher(
    await signedControlRequest(config, "PUT", body, condition),
  );
  if (response.status === 412 || response.status === 409) {
    const current = await readControlObject(config, fetcher);
    const error = new Error("auth_control_cas_lost");
    error.currentHeadHash = current?.bodyHash ?? null;
    throw error;
  }
  if (response.status !== 200) invalid();
  const readback = await readControlObject(config, fetcher);
  if (!readback || canonicalV2(readback.head) !== body)
    throw new Error("auth_control_write_unconfirmed");
  return readback;
}
