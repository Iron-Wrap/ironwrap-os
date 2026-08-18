// jobnimbus.ts — push an envelope into JobNimbus (the CRM spine, per spec 00/03).
//
// LIVE-VERIFIED 2026-06-28 against api1:
//   • auth = `Authorization: Bearer <key>`; list = `{count,results}`; id = `jnid`;
//     `filter` param works but is eventually-consistent (~1s lag).
//   • valid record types: contact `Customer`, job `Retail` ("Lead" 400s).
//   • `source_name` must be an account-configured Lead Source — OMITTED (unknown values 400);
//     source is carried in `tags` + `description`.
//   • createContact **400s "Duplicate contact exists"** on a duplicate display_name — it does NOT
//     upsert. We DEDUP first (bus tag → email → phone); an ambiguous duplicate response can
//     reconcile only through one stable-identity search plus exact material provider readback.
//   • api1 has no DELETE (soft-delete via `PUT {is_archived:true}`). The bus's D1 status is the
//     instant idempotency guard; JN search is the cross-system backstop.

import { isOn, normalizeEmail, normalizePhone, type EnvelopeRecord } from "./core.ts";
import { adapterAuthority, assertEffectLedgerReady, runExternalEffect } from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

const JN_BASE = "https://app.jobnimbus.com/api1";

export interface JnResult {
  contactId: string;
  jobId?: string;
  jobNumber?: string; // JN human job number (for the Google Drive folder), set only on a fresh job
  reused: boolean;
}

function materialFields(path: string, body: unknown): Record<string, unknown> {
  const root = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const tags = Array.isArray(root.tags)
    ? [...root.tags].filter((value): value is string => typeof value === "string" && value.trim().length > 0).sort()
    : undefined;
  if (path.startsWith("/contacts")) {
    return compact({
      record_type_name: root.record_type_name,
      status_name: root.status_name,
      names: root.names,
      is_lead: root.is_lead,
      display_name: root.display_name,
      first_name: root.first_name,
      last_name: root.last_name,
      email: normalizeEmail(root.email),
      mobile_phone: normalizePhone(root.mobile_phone),
      address_line1: root.address_line1,
      city: root.city,
      state_text: root.state_text,
      zip: root.zip,
      country_name: root.country_name,
      external_id: root.external_id,
      description: root.description,
      tags,
    });
  }
  if (path.startsWith("/jobs")) {
    const related = Array.isArray(root.related)
      ? root.related
          .filter(
            (value): value is Record<string, unknown> =>
              !!value && typeof value === "object" && !Array.isArray(value),
          )
          .map((value) => compact({ id: value.id, type: value.type }))
          .sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          )
      : undefined;
    return compact({
      record_type_name: root.record_type_name,
      status_name: root.status_name,
      name: root.name,
      related,
      external_id: root.external_id,
      tags,
    });
  }
  return compact({ tags });
}

async function readbackFields(path: string, body: unknown): Promise<{ material_sha256: string }> {
  return { material_sha256: await sha256Hex(canonicalJson(materialFields(path, body))) };
}

function projectMaterialShape(observed: unknown, expected: unknown): unknown {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) return observed;
    const itemShape = expected.find((value) => value !== undefined);
    return itemShape === undefined
      ? observed
      : observed.map((value) => projectMaterialShape(value, itemShape));
  }
  if (expected && typeof expected === "object") {
    const observedRecord = observed && typeof observed === "object" && !Array.isArray(observed)
      ? observed as Record<string, unknown>
      : {};
    return Object.fromEntries(Object.entries(expected as Record<string, unknown>).map(([key, value]) => [
      key,
      projectMaterialShape(observedRecord[key], value),
    ]));
  }
  return observed;
}

export async function pushToJobNimbus(env: Env, rec: EnvelopeRecord): Promise<JnResult> {
  if (!isOn(env.JOBNIMBUS_ENABLED)) {
    throw new Error("jobnimbus_disabled: set JOBNIMBUS_ENABLED=true once the live write path is approved");
  }
  if (!env.JOBNIMBUS_API_KEY) throw new Error("jobnimbus_no_key");

  const busTag = `bus:${rec.envelope_id}`;
  const p = safeJson(rec.payload_json);
  const brand = str(p.brand); // "ironwrap" | "iroof" — carried from the website form
  const routable = !!rec.intent_queue && rec.intent_queue !== "human_qualification";
  const tags = ["ironwrap-bus", busTag, `source:${rec.source}`]
    .concat(brand ? [`brand:${brand}`] : [])
    .concat(rec.intent_queue ? [`queue:${rec.intent_queue}`] : []);

  // 1) Dedup in priority order: this exact envelope (retry-safe) → existing person by email →
  //    by phone (mobile or home — GHL imports land in home_phone). JN itself blocks dup names.
  let contactId =
    (await searchByTerm(env, "/contacts", "tags", busTag)) ??
    (rec.contact_email ? await searchByTerm(env, "/contacts", "email", rec.contact_email) : null) ??
    (rec.contact_phone ? await searchByTerm(env, "/contacts", "mobile_phone", rec.contact_phone) : null) ??
    (rec.contact_phone ? await searchByTerm(env, "/contacts", "home_phone", rec.contact_phone) : null);
  let reused = !!contactId;

  if (contactId) {
    // Reuse the existing contact; stamp the bus tag so future retries match by tag.
    await jnFetch(env, "PUT", `/contacts/${contactId}`, { tags });
  } else {
    const [first, ...rest] = (rec.contact_name ?? "").trim().split(/\s+/).filter(Boolean);
    const displayName = rec.contact_name ?? rec.contact_phone ?? rec.contact_email ?? `Lead ${rec.envelope_id}`;
    const body: Record<string, unknown> = {
      record_type_name: env.JN_CONTACT_RECORD_TYPE || "Customer",
      status_name: env.JN_CONTACT_STATUS || "New",
      names: "many",
      is_lead: true,
      display_name: displayName,
      first_name: first || undefined,
      last_name: rest.join(" ") || undefined,
      mobile_phone: rec.contact_phone ?? undefined,
      email: rec.contact_email ?? undefined,
      address_line1: str(p.address ?? p.address1 ?? p.address_line1),
      city: str(p.city),
      state_text: str(p.province ?? p.state),
      zip: str(p.postal ?? p.postal_code ?? p.zip),
      country_name: str(p.country),
      external_id: rec.envelope_id,
      description: `Lead via ${rec.source}${rec.intent_queue ? " → " + rec.intent_queue : ""} (bus ${rec.envelope_id})`,
      tags,
    };
    const contact = await jnFetch(env, "POST", "/contacts", body);
    contactId = String(contact.record.jnid ?? "");
    reused = contact.replayed;
    if (!contactId) throw new Error("jobnimbus_contact_no_id");
  }

  // 2) Job for routable intents (idempotent by bus tag; unique-ish name avoids dup-name 400s).
  let jobId: string | undefined;
  let jobNumber: string | undefined;
  if (routable) {
    jobId = (await searchByTerm(env, "/jobs", "tags", busTag)) ?? undefined;
    if (!jobId) {
      const job = await jnFetch(env, "POST", "/jobs", {
        record_type_name: env.JN_JOB_RECORD_TYPE || "Retail",
        status_name: env.JN_JOB_STATUS || "Lead",
        name: `${rec.contact_name ?? "Lead"} — ${rec.source} (${rec.envelope_id.slice(-6)})`,
        related: [{ id: contactId, type: "contact" }],
        external_id: `${rec.envelope_id}:job`,
        tags: ["ironwrap-bus", busTag].concat(rec.intent_queue ? [`queue:${rec.intent_queue}`] : []),
      });
      jobId = String(job.record.jnid ?? "") || undefined;
      jobNumber = job.record.number != null ? String(job.record.number) : undefined; // JN job number -> Google Drive folder
    }
  }
  return { contactId, jobId, jobNumber, reused };
}

/** Search a record type by a single field=value term (filter is the one search path JN supports). */
async function searchByTerm(env: Env, path: string, field: string, value: string | null): Promise<string | null> {
  if (!value) return null;
  const result = await searchUniqueByTerms(env, path, [{ field, value }]);
  if (result.status === "not_found") return null;
  if (result.status !== "match") throw new Error(result.detailCode);
  return result.recordId;
}

interface JobNimbusEffectValue {
  record: Record<string, any>;
  replayed: boolean;
}

async function jnFetch(env: Env, method: string, path: string, body: unknown): Promise<JobNimbusEffectValue> {
  assertEffectLedgerReady(env);
  const tenantId = String((env as Env & { APP_TENANT_ID?: string }).APP_TENANT_ID ?? "ironwrap");
  const action = `jobnimbus.${method.toLowerCase()}`;
  const bodyJson = JSON.stringify(body);
  if (bodyJson === undefined) throw new Error("jobnimbus_body_not_json");
  const normalizedBody = JSON.parse(bodyJson) as unknown;
  const request = { method, path, body: normalizedBody };
  const requestHash = await sha256Hex(canonicalJson(request));
  const idempotencyKey = `jobnimbus:${method}:${path}:${requestHash}`;
  const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
  let ambiguousResponseCode: string | null = null;
  const result = await runExternalEffect(env as never, {
    tenantId,
    actor: { type: "agent", id: "jobnimbus-adapter" },
    taskId: `jobnimbus:${path}`,
    authority: adapterAuthority({ tenantId, provider: "jobnimbus", action, actorId: "jobnimbus-adapter", deadlineAt, retryLimit: 1 }),
    aggregate: { type: "lead", id: path.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 150) || "unknown", version: 0 },
    intentId: idempotencyKey,
    action,
    request,
    requestHash,
    provider: "jobnimbus",
    idempotencyKey,
    deadlineAt,
    expectedReadback: await readbackFields(path, normalizedBody),
    retryLimit: 1,
    compensationPlan: {},
    correlationId: idempotencyKey,
  }, {
    async dispatch() {
      const res = await fetch(JN_BASE + path, {
        method,
        headers: { ...authHeaders(env), "content-type": "application/json" },
        body: bodyJson,
      });
      if (!res.ok) {
        const responseText = (await res.text()).slice(0, 4_000);
        const detailCode = res.status === 400 && /duplicate contact/i.test(responseText)
          ? "jobnimbus_duplicate_contact"
          : `jobnimbus_http_${res.status}`;
        const ambiguous = detailCode === "jobnimbus_duplicate_contact" || res.status >= 500;
        if (ambiguous) ambiguousResponseCode = detailCode;
        return {
          outcome: ambiguous ? "unknown" as const : "rejected" as const,
          detailCode,
          providerResponse: {
            status: res.status,
            body_sha256: await sha256Hex(responseText),
          },
        };
      }
      const value = await res.json() as Record<string, any>;
      return {
        outcome: "accepted" as const,
        value: { record: value, replayed: false },
        providerExternalId: typeof value.jnid === "string" ? value.jnid : null,
        providerResponse: value,
      };
    },
    async readback({ providerExternalId }) {
      const readback = (await jobNimbusReadback(env, path, normalizedBody, providerExternalId)).readback;
      return ambiguousResponseCode && readback.status !== "match"
        ? { ...readback, detailCode: `${ambiguousResponseCode}_${readback.detailCode ?? readback.status}` }
        : readback;
    },
    async replay({ effect }) {
      const replay = await jobNimbusReadback(env, path, normalizedBody, effect.provider_external_id);
      if (replay.readback.status !== "match" || !replay.value) {
        throw new Error(replay.readback.detailCode ?? "jobnimbus_replay_readback_failed");
      }
      return { record: replay.value, replayed: true };
    },
  });
  if (result.effect.state !== "succeeded") {
    throw new Error(result.effect.result_code ?? "jobnimbus_effect_outcome_unknown");
  }
  if (!result.value?.record || typeof result.value.record !== "object") throw new Error("jobnimbus_effect_result_missing");
  return result.value;
}

async function jobNimbusReadback(
  env: Env,
  path: string,
  body: unknown,
  providerExternalId: string | null,
): Promise<{
  readback: {
    status: "match" | "conflict" | "unavailable" | "not_found";
    providerExternalId?: string;
    observed?: unknown;
    detailCode?: string;
  };
  value?: Record<string, any>;
}> {
  try {
    const collectionPath = path.startsWith("/contacts")
      ? "/contacts"
      : path.startsWith("/jobs")
        ? "/jobs"
        : path;
    const pathIdentity =
      /^\/(?:contacts|jobs)\/([^/]+)$/.exec(path)?.[1] ?? null;
    let recordId =
      providerExternalId ??
      (pathIdentity ? decodeURIComponent(pathIdentity) : null);
    if (!recordId) {
      const search = await searchUniqueByTerms(
        env,
        collectionPath,
        stableIdentityTerms(path, body),
      );
      if (search.status !== "match") {
        return {
          readback: {
            status: search.status,
            detailCode: search.detailCode,
          },
        };
      }
      recordId = search.recordId;
    }
    if (!recordId)
      return {
        readback: {
          status: "not_found",
          detailCode: "jobnimbus_readback_not_found",
        },
      };
    const res = await fetch(
      `${JN_BASE}${collectionPath}/${encodeURIComponent(recordId)}`,
      {
        headers: authHeaders(env),
      },
    );
    if (res.status === 404)
      return {
        readback: {
          status: "not_found",
          detailCode: "jobnimbus_readback_not_found",
        },
      };
    if (!res.ok)
      return {
        readback: {
          status: "unavailable",
          detailCode: `jobnimbus_readback_${res.status}`,
        },
      };
    const value = (await res.json()) as Record<string, any>;
    const expectedMaterial = materialFields(path, body);
    const observedMaterial = projectMaterialShape(
      materialFields(path, value),
      expectedMaterial,
    );
    const observed = {
      material_sha256: await sha256Hex(canonicalJson(observedMaterial)),
    };
    const expected = {
      material_sha256: await sha256Hex(canonicalJson(expectedMaterial)),
    };
    return String(value.jnid ?? "") === recordId &&
      canonicalJson(observed) === canonicalJson(expected)
      ? {
          readback: { status: "match", providerExternalId: recordId, observed },
          value,
        }
      : {
          readback: {
            status: "conflict",
            providerExternalId: recordId,
            observed: { jnid: value.jnid, ...observed },
            detailCode: "jobnimbus_readback_conflict",
          },
          value,
        };
  } catch {
    return {
      readback: {
        status: "unavailable",
        detailCode: "jobnimbus_readback_unavailable",
      },
    };
  }
}

function stableIdentityTerms(
  path: string,
  body: unknown,
): Array<{ field: string; value: string }> {
  const material = materialFields(path, body);
  const terms: Array<{ field: string; value: string }> = [];
  const add = (field: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) terms.push({ field, value: value.trim() });
  };
  add("external_id", material.external_id);
  if (path.startsWith("/contacts")) {
    add("email", material.email);
    add("mobile_phone", material.mobile_phone);
  }
  const tags = Array.isArray(material.tags) ? material.tags : [];
  for (const tag of tags) {
    if (typeof tag === "string" && (tag.startsWith("bus:") || tag.startsWith("source:"))) {
      add("tags", tag);
    }
  }
  return terms;
}

async function searchUniqueByTerms(
  env: Env,
  path: string,
  terms: Array<{ field: string; value: string }>,
): Promise<
  | { status: "match"; recordId: string; detailCode?: undefined }
  | { status: "not_found" | "conflict" | "unavailable"; detailCode: string; recordId?: undefined }
> {
  if (terms.length === 0) {
    return { status: "conflict", detailCode: "jobnimbus_readback_identity_missing" };
  }
  const filter = JSON.stringify({
    must: terms.map(({ field, value }) => ({ term: { [field]: value } })),
  });
  try {
    const res = await fetch(`${JN_BASE}${path}?size=2&filter=${encodeURIComponent(filter)}`, {
      headers: authHeaders(env),
    });
    if (!res.ok) {
      await res.text();
      return { status: "unavailable", detailCode: `jobnimbus_search_${res.status}` };
    }
    const payload = await res.json() as { count?: unknown; results?: unknown };
    if (!Array.isArray(payload.results)) {
      return { status: "conflict", detailCode: "jobnimbus_readback_search_incomplete" };
    }
    const count = payload.count === undefined ? payload.results.length : payload.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return { status: "conflict", detailCode: "jobnimbus_readback_search_incomplete" };
    }
    if (count === 0 && payload.results.length === 0) {
      return { status: "not_found", detailCode: "jobnimbus_readback_not_found" };
    }
    if (count > 1 || payload.results.length > 1) {
      return { status: "conflict", detailCode: "jobnimbus_readback_multiple_candidates" };
    }
    if (count !== 1 || payload.results.length !== 1) {
      return { status: "conflict", detailCode: "jobnimbus_readback_search_incomplete" };
    }
    const candidate = payload.results[0];
    const recordId = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as { jnid?: unknown }).jnid
      : null;
    return typeof recordId === "string" && recordId
      ? { status: "match", recordId }
      : { status: "conflict", detailCode: "jobnimbus_readback_candidate_incomplete" };
  } catch {
    return { status: "unavailable", detailCode: "jobnimbus_search_unavailable" };
  }
}

function authHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.JOBNIMBUS_API_KEY}`, accept: "application/json" };
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
