/**
 * Public company branding and logo bytes around the canonical D1 company profile.
 *
 * `company-setup-store.ts` owns every profile field, version, and revision. This module
 * deliberately owns only the concerns that do not belong in that aggregate: validating
 * uploaded image bytes, storing those bytes in R2, and presenting the saved profile to
 * public/customer-facing surfaces. R2 never stores a second profile document.
 */
import type { AppEnv, AppRole } from "./app-types.ts";
import {
  COMPANY_LOGO_CONTENT_TYPES,
  companyProfileDefaults,
  getCompanyProfile,
  updateCompanyProfile,
  type CompanyBrandLabel,
  type CompanyLogoContentType,
  type CompanyLogoRecord,
  type CompanyProfile,
  type CompanyProfileFields,
  type UpdateCompanyProfileResult,
} from "./company-setup-store.ts";

export { COMPANY_LOGO_CONTENT_TYPES, companyProfileDefaults };
export type {
  CompanyBrandLabel,
  CompanyLogoContentType,
  CompanyLogoRecord,
  CompanyProfile,
};

export const COMPANY_LOGO_MAX_BYTES = 512 * 1024;

/** Exactly the owner-saved contact that a customer may see; defaults are never published. */
export function publicCompanyContact(
  profile: CompanyProfile,
): { phone: string | null; email: string | null } | null {
  if (profile.is_default) return null;
  const phone = publicPhone(profile.phone, profile.country);
  const email = profile.email.trim();
  const publicEmail = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)
    ? email
    : null;
  return phone || publicEmail ? { phone, email: publicEmail } : null;
}

function publicPhone(phone: string, country: string): string | null {
  const value = phone.trim();
  if (!value || !/^\+?[0-9 ().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  if (value.startsWith("+")) {
    return /^[1-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : null;
  }
  // A local number needs an explicit North American country on the saved profile. Never infer a
  // dialling country from the deployment, customer device, or tenant name.
  const northAmerican = ["ca", "canada", "us", "usa", "united states"].includes(
    country.trim().toLowerCase(),
  );
  if (!northAmerican) return null;
  const tenDigits = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(tenDigits) ? `+1${tenDigits}` : null;
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

function logoKey(tenantId: string, version: string): string {
  return `tenant-config/${tenantId}/logo/${version}`;
}

/** The one profile all authenticated and public surfaces read. */
export async function resolveCompanyProfile(
  env: AppEnv,
  tenantId: string,
): Promise<CompanyProfile> {
  return await getCompanyProfile(env, tenantId);
}

export interface CompanyLogoUpload {
  content_type: CompanyLogoContentType;
  bytes: Uint8Array;
  expected_profile_version: number;
}

export interface CompanyProfileMutationContext {
  actorUserId: string;
  actorRole: AppRole;
  idempotencyKey: string;
  now: string;
}

export async function saveCompanyLogo(
  env: AppEnv,
  tenantId: string,
  upload: CompanyLogoUpload,
  context: CompanyProfileMutationContext,
): Promise<UpdateCompanyProfileResult> {
  const current = await getCompanyProfile(env, tenantId);
  const version = await contentVersion(upload.bytes);
  const logo: CompanyLogoRecord = {
    content_type: upload.content_type,
    byte_size: upload.bytes.byteLength,
    version,
    updated_at: context.now,
  };
  const update = {
    tenantId,
    fields: profileFields(current),
    logo,
    expectedProfileVersion: upload.expected_profile_version,
    idempotencyKey: context.idempotencyKey,
    actorUserId: context.actorUserId,
    actorRole: context.actorRole,
    now: context.now,
  };

  // Let the existing authority path answer a replay or stale command before consuming R2.
  // A concurrent version change after this check can still leave one inert object, but a request
  // that was already stale when it arrived cannot accumulate content-addressed garbage.
  if (upload.expected_profile_version !== current.profile_version) {
    return await updateCompanyProfile(env, update);
  }

  // Publish bytes before their D1 reference. A lost optimistic-version race can leave an
  // unreferenced content-addressed object, but it can never publish a broken customer URL.
  await env.RAW.put(logoKey(tenantId, version), upload.bytes, {
    httpMetadata: { contentType: upload.content_type },
  });
  const result = await updateCompanyProfile(env, update);
  // Do not delete the prior content-addressed object here. Another request can re-select that
  // version after this D1 commit but before a delete runs, which would break the newer canonical
  // profile. A future collector must re-read D1 and apply a retention window before deletion.
  return result;
}

export async function removeCompanyLogo(
  env: AppEnv,
  tenantId: string,
  expectedProfileVersion: number,
  context: CompanyProfileMutationContext,
): Promise<UpdateCompanyProfileResult> {
  const current = await getCompanyProfile(env, tenantId);
  const result = await updateCompanyProfile(env, {
    tenantId,
    fields: profileFields(current),
    logo: null,
    expectedProfileVersion,
    idempotencyKey: context.idempotencyKey,
    actorUserId: context.actorUserId,
    actorRole: context.actorRole,
    now: context.now,
  });
  // Retain the unreferenced bytes for the same concurrency reason as replacement above. Removal
  // changes only the canonical D1 reference; public serving stops immediately and safely.
  return result;
}

function profileFields(profile: CompanyProfile): CompanyProfileFields {
  const {
    tenant_id: _tenantId,
    profile_version: _profileVersion,
    is_default: _isDefault,
    logo_ref: _logoRef,
    logo: _logo,
    updated_at: _updatedAt,
    updated_by_user_id: _updatedBy,
    ...fields
  } = profile;
  return fields;
}

/** The customer-facing logo served before a session exists. */
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
      "cache-control": "public, max-age=300",
    },
  });
}

export function companyLogoUrl(profile: CompanyProfile): string | null {
  return profile.logo
    ? `/public/company-logo?v=${encodeURIComponent(profile.logo.version)}`
    : null;
}

export function brandLabel(
  profile: CompanyProfile,
  brandId: string,
): CompanyBrandLabel {
  const owned = profile.brand_labels[brandId];
  if (owned) return owned;
  if (brandId === profile.tenant_id) {
    return {
      display_name: profile.company_name || brandId,
      short_name: profile.brand_name || profile.company_name || brandId,
      service_area: profile.service_area,
    };
  }
  return {
    display_name: brandId,
    short_name: brandId,
    service_area: profile.service_area,
  };
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

/** Public/profile fields only; the API adds operating conventions and expected version. */
export function parseCompanyProfileInput(
  value: unknown,
): { ok: true; value: CompanyProfileInput } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set(Object.keys(TEXT_LIMITS));
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, error: "unexpected_field" };
  }

  const companyName = text(value.company_name, TEXT_LIMITS.company_name);
  if (!companyName) return { ok: false, error: "invalid_company_name" };
  const brandName = text(value.brand_name, TEXT_LIMITS.brand_name);
  if (!brandName) return { ok: false, error: "invalid_brand_name" };

  const optional: Record<string, string> = {};
  for (const field of [
    "service_area",
    "phone",
    "email",
    "website",
    "address_line1",
    "address_line2",
    "city",
    "region",
    "postal_code",
    "country",
  ] as const) {
    const supplied = value[field];
    if (supplied === undefined || supplied === null) {
      optional[field] = "";
      continue;
    }
    if (typeof supplied !== "string")
      return { ok: false, error: `invalid_${field}` };
    const trimmed = supplied.trim();
    if (trimmed.length > TEXT_LIMITS[field])
      return { ok: false, error: `invalid_${field}` };
    optional[field] = trimmed;
  }
  if (optional.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(optional.email)) {
    return { ok: false, error: "invalid_email" };
  }
  if (optional.website && !/^https?:\/\/\S+$/.test(optional.website)) {
    return { ok: false, error: "invalid_website" };
  }
  if (optional.phone && !/^[0-9 ()+.\-]{7,32}$/.test(optional.phone)) {
    return { ok: false, error: "invalid_phone" };
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

export function parseCompanyLogoInput(
  value: unknown,
): { ok: true; value: CompanyLogoUpload } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set([
    "content_type",
    "data_base64",
    "expected_profile_version",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, error: "unexpected_field" };
  }
  const expected = expectedProfileVersion(value.expected_profile_version);
  if (expected === null)
    return { ok: false, error: "invalid_expected_profile_version" };
  const contentType =
    typeof value.content_type === "string" ? value.content_type.trim() : "";
  if (
    !(COMPANY_LOGO_CONTENT_TYPES as readonly string[]).includes(contentType)
  ) {
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
  if (bytes.byteLength > COMPANY_LOGO_MAX_BYTES)
    return { ok: false, error: "logo_too_large" };
  if (!magicBytesMatch(contentType as CompanyLogoContentType, bytes)) {
    return { ok: false, error: "logo_content_mismatch" };
  }
  return {
    ok: true,
    value: {
      content_type: contentType as CompanyLogoContentType,
      bytes,
      expected_profile_version: expected,
    },
  };
}

export function parseCompanyLogoRemovalInput(
  value: unknown,
): { ok: true; expectedProfileVersion: number } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  if (
    Object.keys(value).length !== 1 ||
    !("expected_profile_version" in value)
  ) {
    return { ok: false, error: "unexpected_field" };
  }
  const expected = expectedProfileVersion(value.expected_profile_version);
  return expected === null
    ? { ok: false, error: "invalid_expected_profile_version" }
    : { ok: true, expectedProfileVersion: expected };
}

function expectedProfileVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 1_000_000
    ? (value as number)
    : null;
}

function magicBytesMatch(
  contentType: CompanyLogoContentType,
  bytes: Uint8Array,
): boolean {
  if (contentType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/jpeg")
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (contentType === "image/webp") {
    return (
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.byteLength > 12 &&
      startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
    );
  }
  // The payload is already bounded to 512 KiB. Scan all validated bytes so a dangerous construct
  // cannot be hidden after an otherwise harmless prefix.
  const source = new TextDecoder().decode(bytes).toLowerCase();
  return (
    source.includes("<svg") &&
    !/<script|\son\w+\s*=|javascript:|<foreignobject/.test(source)
  );
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.byteLength >= prefix.length &&
    prefix.every((byte, index) => bytes[index] === byte)
  );
}

function parseBrandLabels(
  value: unknown,
):
  | { ok: true; value: Record<string, CompanyBrandLabel> }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, error: "invalid_brand_labels" };
  const labels: Record<string, CompanyBrandLabel> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!BRAND_ID.test(id) || !isRecord(raw)) {
      return { ok: false, error: "invalid_brand_labels" };
    }
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
    if (Object.keys(labels).length > 32)
      return { ok: false, error: "invalid_brand_labels" };
  }
  return { ok: true, value: labels };
}

async function contentVersion(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
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
