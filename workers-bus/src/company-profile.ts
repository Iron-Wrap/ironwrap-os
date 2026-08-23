/**
 * The company profile — the half of tenant configuration an owner sets for themselves.
 *
 * Until now a tenant's own name, address, brand and logo were only reachable by editing
 * `config/tenants/<tenant>.json` and running two CLI tools (docs/WHITE-LABEL-CLONE-PLAYBOOK.md
 * step 1), which puts "enter company details, upload a logo, start working" behind an engineer.
 * This module is the runtime overlay on that file: the generated Worker vars remain the
 * deployment-time defaults, and anything the owner edits in the app wins over them.
 *
 * Storage is a single R2 document per tenant under `tenant-config/`, deliberately NOT a D1 table:
 * this is one small configuration document with no relations, no history requirement and no
 * query surface, and it keeps the onboarding screens off the product schema. The logo is a second
 * R2 object beside it, addressed by a content version so a replaced logo never serves stale bytes
 * from a cache. Promote both into D1 when a tenant needs more than one profile (multi-office is
 * M3 territory); nothing outside this module knows where the bytes live.
 */
import type { AppEnv } from "./app-types.ts";

export const COMPANY_LOGO_MAX_BYTES = 512 * 1024;

/**
 * Raster formats plus SVG. SVG is accepted because a contractor's logo usually arrives as one and
 * refusing it would send them back to an engineer, which is the whole defect being fixed here.
 * Two things keep an uploaded file from becoming a script: `magicBytesMatch` refuses SVG bytes
 * carrying `<script>`, an inline event handler, a `javascript:` URL or a `<foreignObject>`, and
 * every Worker response — including `/public/company-logo` — already carries the Worker-wide
 * `default-src 'none'` Content-Security-Policy plus `X-Content-Type-Options: nosniff`.
 */
export const COMPANY_LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

export type CompanyLogoContentType = (typeof COMPANY_LOGO_CONTENT_TYPES)[number];

export interface CompanyBrandLabel {
  display_name: string;
  short_name: string;
  service_area: string;
}

export interface CompanyLogoRecord {
  content_type: CompanyLogoContentType;
  byte_size: number;
  /** Content-addressed; also the R2 object suffix and the `v=` cache buster on the public URL. */
  version: string;
  updated_at: string;
}

export interface CompanyProfile {
  tenant_id: string;
  company_name: string;
  brand_name: string;
  service_area: string;
  phone: string;
  email: string;
  website: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  /** Public-facing labels per brand id the Worker accepts. Keyed by `PUBLIC_ESTIMATE_ALLOWED_BRANDS`. */
  brand_labels: Record<string, CompanyBrandLabel>;
  logo: CompanyLogoRecord | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface CompanyProfileInput {
  company_name: string;
  brand_name: string;
  service_area: string;
  phone: string;
  email: string;
  website: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  brand_labels: Record<string, CompanyBrandLabel>;
}

const TEXT_LIMITS: Readonly<Record<keyof CompanyProfileInput, number>> = {
  company_name: 120,
  brand_name: 80,
  service_area: 120,
  phone: 32,
  email: 160,
  website: 200,
  address_line1: 160,
  address_line2: 160,
  city: 80,
  region: 80,
  postal_code: 24,
  country: 80,
  brand_labels: 0,
};

const BRAND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function profileKey(tenantId: string): string {
  return `tenant-config/${tenantId}/company-profile.json`;
}

function logoKey(tenantId: string, version: string): string {
  return `tenant-config/${tenantId}/logo/${version}`;
}

/** The deployment-time defaults an owner has not overridden yet. */
export function companyProfileDefaults(env: AppEnv, tenantId: string): CompanyProfile {
  return {
    tenant_id: tenantId,
    company_name: text(env.APP_TENANT_NAME, TEXT_LIMITS.company_name),
    brand_name: text(env.APP_TENANT_BRAND, TEXT_LIMITS.brand_name),
    service_area: "",
    phone: "",
    email: "",
    website: "",
    address_line1: "",
    address_line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "",
    brand_labels: {},
    logo: null,
    updated_at: null,
    updated_by: null,
  };
}

/** The profile as the product should read it: what the owner saved, else the generated defaults. */
export async function resolveCompanyProfile(
  env: AppEnv,
  tenantId: string,
): Promise<CompanyProfile> {
  const stored = await readCompanyProfile(env, tenantId);
  return stored ?? companyProfileDefaults(env, tenantId);
}

export async function readCompanyProfile(
  env: AppEnv,
  tenantId: string,
): Promise<CompanyProfile | null> {
  const object = await env.RAW.get(profileKey(tenantId));
  if (!object) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text()) as unknown;
  } catch {
    return null;
  }
  return normalizeStoredProfile(parsed, env, tenantId);
}

export async function writeCompanyProfile(
  env: AppEnv,
  profile: CompanyProfile,
): Promise<CompanyProfile> {
  await env.RAW.put(profileKey(profile.tenant_id), JSON.stringify(profile), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return profile;
}

export async function saveCompanyProfile(
  env: AppEnv,
  tenantId: string,
  input: CompanyProfileInput,
  actor: string,
  now: string,
): Promise<CompanyProfile> {
  const current = await resolveCompanyProfile(env, tenantId);
  return await writeCompanyProfile(env, {
    ...current,
    ...input,
    tenant_id: tenantId,
    logo: current.logo,
    updated_at: now,
    updated_by: actor,
  });
}

export interface CompanyLogoUpload {
  content_type: CompanyLogoContentType;
  bytes: Uint8Array;
}

export async function saveCompanyLogo(
  env: AppEnv,
  tenantId: string,
  upload: CompanyLogoUpload,
  actor: string,
  now: string,
): Promise<CompanyProfile> {
  const version = await contentVersion(upload.bytes);
  const current = await resolveCompanyProfile(env, tenantId);
  await env.RAW.put(logoKey(tenantId, version), upload.bytes, {
    httpMetadata: { contentType: upload.content_type },
  });
  return await writeCompanyProfile(env, {
    ...current,
    tenant_id: tenantId,
    logo: {
      content_type: upload.content_type,
      byte_size: upload.bytes.byteLength,
      version,
      updated_at: now,
    },
    updated_at: now,
    updated_by: actor,
  });
}

export async function removeCompanyLogo(
  env: AppEnv,
  tenantId: string,
  actor: string,
  now: string,
): Promise<CompanyProfile> {
  const current = await resolveCompanyProfile(env, tenantId);
  if (current.logo) {
    await env.RAW.delete(logoKey(tenantId, current.logo.version));
  }
  return await writeCompanyProfile(env, {
    ...current,
    tenant_id: tenantId,
    logo: null,
    updated_at: now,
    updated_by: actor,
  });
}

/**
 * The customer-facing logo. Served from the public path because the estimate request form and the
 * sign-in screen both render before there is any session to authorize.
 */
export async function companyLogoResponse(
  env: AppEnv,
  tenantId: string,
): Promise<Response> {
  const profile = await resolveCompanyProfile(env, tenantId);
  if (!profile.logo) return new Response(null, { status: 404 });
  const object = await env.RAW.get(logoKey(tenantId, profile.logo.version));
  if (!object) return new Response(null, { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": profile.logo.content_type,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      // Short and not immutable: the app shell asks for this path without the `v=` version, so a
      // replaced logo has to reach an already-open tab on its own.
      "cache-control": "public, max-age=300",
    },
  });
}

/** The public URL for a profile's logo, or null when the owner has not uploaded one. */
export function companyLogoUrl(profile: CompanyProfile): string | null {
  return profile.logo
    ? `/public/company-logo?v=${encodeURIComponent(profile.logo.version)}`
    : null;
}

/**
 * The label a public surface shows for one brand id the Worker accepts.
 *
 * Order: what the owner typed for that exact brand, then the tenant's own company profile when the
 * brand id IS the tenant, then the brand id itself. There is deliberately no built-in table of
 * brand names — a hard-coded `{ ironwrap, iroof }` map in the frontend is the defect this replaces.
 */
export function brandLabel(profile: CompanyProfile, brandId: string): CompanyBrandLabel {
  const owned = profile.brand_labels[brandId];
  if (owned) return owned;
  if (brandId === profile.tenant_id) {
    return {
      display_name: profile.company_name || brandId,
      short_name: profile.brand_name || profile.company_name || brandId,
      service_area: profile.service_area,
    };
  }
  return { display_name: brandId, short_name: brandId, service_area: profile.service_area };
}

export interface PublicBrandDescriptor extends CompanyBrandLabel {
  id: string;
}

export function publicBrandDescriptors(
  profile: CompanyProfile,
  brandIds: Iterable<string>,
): PublicBrandDescriptor[] {
  return [...brandIds].map((id) => ({ id, ...brandLabel(profile, id) }));
}

export function parseCompanyProfileInput(
  value: unknown,
): { ok: true; value: CompanyProfileInput } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set(Object.keys(TEXT_LIMITS));
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) return { ok: false, error: "unexpected_field" };

  const companyName = text(value.company_name, TEXT_LIMITS.company_name);
  if (!companyName) return { ok: false, error: "invalid_company_name" };
  const brandName = text(value.brand_name, TEXT_LIMITS.brand_name);
  if (!brandName) return { ok: false, error: "invalid_brand_name" };

  const optional: Record<string, string> = {};
  for (const field of [
    "service_area", "phone", "email", "website", "address_line1", "address_line2",
    "city", "region", "postal_code", "country",
  ] as const) {
    const supplied = value[field];
    if (supplied === undefined || supplied === null) {
      optional[field] = "";
      continue;
    }
    if (typeof supplied !== "string") return { ok: false, error: `invalid_${field}` };
    const trimmed = supplied.trim();
    if (trimmed.length > TEXT_LIMITS[field]) return { ok: false, error: `invalid_${field}` };
    optional[field] = trimmed;
  }
  if (optional.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(optional.email)) {
    return { ok: false, error: "invalid_email" };
  }
  if (optional.website && !/^https?:\/\/\S+$/.test(optional.website)) {
    return { ok: false, error: "invalid_website" };
  }

  const brandLabels = parseBrandLabels(value.brand_labels);
  if (!brandLabels.ok) return brandLabels;

  return {
    ok: true,
    value: {
      company_name: companyName,
      brand_name: brandName,
      service_area: optional.service_area!,
      phone: optional.phone!,
      email: optional.email!,
      website: optional.website!,
      address_line1: optional.address_line1!,
      address_line2: optional.address_line2!,
      city: optional.city!,
      region: optional.region!,
      postal_code: optional.postal_code!,
      country: optional.country!,
      brand_labels: brandLabels.value,
    },
  };
}

/**
 * A logo arrives base64-encoded inside JSON rather than as multipart, because the PWA already
 * reads the file with `FileReader` for its own preview and every other authenticated write on this
 * API is a JSON body with the same CSRF check. One transport, one validation path.
 */
export function parseCompanyLogoInput(
  value: unknown,
): { ok: true; value: CompanyLogoUpload } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set(["content_type", "data_base64"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, error: "unexpected_field" };
  }
  const contentType = typeof value.content_type === "string" ? value.content_type.trim() : "";
  if (!(COMPANY_LOGO_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return { ok: false, error: "unsupported_logo_type" };
  }
  if (typeof value.data_base64 !== "string" || value.data_base64.length === 0) {
    return { ok: false, error: "invalid_logo_data" };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(value.data_base64);
  } catch {
    return { ok: false, error: "invalid_logo_data" };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "invalid_logo_data" };
  if (bytes.byteLength > COMPANY_LOGO_MAX_BYTES) return { ok: false, error: "logo_too_large" };
  if (!magicBytesMatch(contentType as CompanyLogoContentType, bytes)) {
    return { ok: false, error: "logo_content_mismatch" };
  }
  return { ok: true, value: { content_type: contentType as CompanyLogoContentType, bytes } };
}

/**
 * The declared content type has to be backed by the bytes. Without this a caller could store a
 * script under `image/png` and have `/public/company-logo` hand it back with that content type.
 */
function magicBytesMatch(contentType: CompanyLogoContentType, bytes: Uint8Array): boolean {
  if (contentType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (contentType === "image/webp") {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.byteLength > 12 &&
      startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  }
  // SVG has no magic number. Require a root element and refuse the constructs that would make a
  // stored image executable if it were ever opened as a document.
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).toLowerCase();
  if (!head.includes("<svg")) return false;
  return !/<script|\son\w+\s*=|javascript:|<foreignobject/.test(head);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function parseBrandLabels(
  value: unknown,
): { ok: true; value: Record<string, CompanyBrandLabel> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, error: "invalid_brand_labels" };
  const labels: Record<string, CompanyBrandLabel> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!BRAND_ID.test(id)) return { ok: false, error: "invalid_brand_labels" };
    if (!isRecord(raw)) return { ok: false, error: "invalid_brand_labels" };
    const allowed = new Set(["display_name", "short_name", "service_area"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      return { ok: false, error: "invalid_brand_labels" };
    }
    const displayName = text(raw.display_name, TEXT_LIMITS.company_name);
    if (!displayName) return { ok: false, error: "invalid_brand_labels" };
    labels[id] = {
      display_name: displayName,
      short_name: text(raw.short_name, TEXT_LIMITS.brand_name) || displayName,
      service_area: text(raw.service_area, TEXT_LIMITS.service_area),
    };
    if (Object.keys(labels).length > 32) return { ok: false, error: "invalid_brand_labels" };
  }
  return { ok: true, value: labels };
}

function normalizeStoredProfile(
  value: unknown,
  env: AppEnv,
  tenantId: string,
): CompanyProfile {
  const defaults = companyProfileDefaults(env, tenantId);
  if (!isRecord(value)) return defaults;
  const parsed = parseCompanyProfileInput({
    company_name: value.company_name,
    brand_name: value.brand_name,
    service_area: value.service_area,
    phone: value.phone,
    email: value.email,
    website: value.website,
    address_line1: value.address_line1,
    address_line2: value.address_line2,
    city: value.city,
    region: value.region,
    postal_code: value.postal_code,
    country: value.country,
    brand_labels: value.brand_labels,
  });
  const fields = parsed.ok
    ? parsed.value
    : {
        ...defaults,
        brand_labels: {},
      };
  return {
    ...defaults,
    ...fields,
    tenant_id: tenantId,
    logo: storedLogo(value.logo),
    updated_at: text(value.updated_at, 40) || null,
    updated_by: text(value.updated_by, 160) || null,
  };
}

function storedLogo(value: unknown): CompanyLogoRecord | null {
  if (!isRecord(value)) return null;
  const contentType = text(value.content_type, 64);
  const version = text(value.version, 128);
  const byteSize = typeof value.byte_size === "number" ? value.byte_size : 0;
  if (!(COMPANY_LOGO_CONTENT_TYPES as readonly string[]).includes(contentType)) return null;
  if (!version) return null;
  return {
    content_type: contentType as CompanyLogoContentType,
    byte_size: byteSize,
    version,
    updated_at: text(value.updated_at, 40),
  };
}

async function contentVersion(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? "" : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
