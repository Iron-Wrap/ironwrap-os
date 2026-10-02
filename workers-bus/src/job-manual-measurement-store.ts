import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const MANUAL_REQUEST_ID =
  /^manual-measurement:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBSERVATION_ID = /^mobs_[0-9a-f]{64}$/;
const AREA_ID = /^marea_[0-9a-f]{64}$/;
export interface ManualMeasurementInput {
  expected_job_version: number;
  expected_observation_head: string | null;
  target: { area_id: string } | { new_area_label: string };
  area_sq_ft: number | null;
  area_basis: "roof_surface" | "horizontal_plan" | "unknown";
  pitch_rise_per_12: number | null;
  method: "tape" | "laser" | "plans" | "drone";
  uncertainty: string | null;
  correction_reason: string | null;
}
export interface ManualObservation {
  id: string;
  job_id: string;
  area_id: string;
  area_label: string;
  revision: number;
  sequence: number;
  area_sq_ft: number | null;
  area_basis: ManualMeasurementInput["area_basis"];
  pitch_rise_per_12: number | null;
  method: ManualMeasurementInput["method"];
  uncertainty: string | null;
  correction_reason: string | null;
  supersedes_observation_id: string | null;
  previous_head_id: string | null;
  job_version: number;
  recorded_by: string;
  recorded_at: string;
  sha256: string;
}
interface ObservationRow extends Omit<
  ManualObservation,
  "id" | "job_id" | "sha256"
> {
  observation_id: string;
  roof_job_id: string;
  observation_sha256: string;
  tenant_id: string;
  request_id: string;
  request_hash: string;
}
interface ReceiptRow {
  tenant_id: string;
  request_id: string;
  roof_job_id: string;
  actor_user_id: string;
  request_hash: string;
  input_json: string;
  observation_id: string;
  recorded_at: string;
}
export class ManualMeasurementError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const refuse = (code: string, status = 400): never => {
  throw new ManualMeasurementError(code, status);
};
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const boundedInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1_000_000;
export function validManualJobId(value: string) {
  return (
    value.length >= 8 &&
    value.length <= 200 &&
    !/[\s/\\?#]/.test(value) &&
    value !== ".."
  );
}
export function parseManualMeasurementInput(
  value: unknown,
): ManualMeasurementInput {
  const keys = [
    "expected_job_version",
    "expected_observation_head",
    "target",
    "area_sq_ft",
    "area_basis",
    "pitch_rise_per_12",
    "method",
    "uncertainty",
    "correction_reason",
  ];
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    refuse("invalid_manual_measurement");
  const v = value as Record<string, unknown>;
  if (
    !boundedInteger(v.expected_job_version) ||
    !(
      v.expected_observation_head === null ||
      (typeof v.expected_observation_head === "string" &&
        OBSERVATION_ID.test(v.expected_observation_head))
    )
  )
    refuse("invalid_manual_measurement_version");
  if (!object(v.target) || Object.keys(v.target).length !== 1)
    refuse("invalid_manual_measurement_target");
  const target = v.target as Record<string, unknown>;
  if (
    !(typeof target.area_id === "string" && AREA_ID.test(target.area_id)) &&
    !(
      typeof target.new_area_label === "string" &&
      target.new_area_label.trim().length >= 1 &&
      target.new_area_label.trim().length <= 120
    )
  )
    refuse("invalid_manual_measurement_target");
  if (!(
    v.area_sq_ft === null ||
    (typeof v.area_sq_ft === "number" &&
      Number.isFinite(v.area_sq_ft) &&
      v.area_sq_ft > 0 &&
      v.area_sq_ft <= 250_000)
  ))
    refuse("invalid_manual_measurement_area");
  if (!(
    v.pitch_rise_per_12 === null ||
    (typeof v.pitch_rise_per_12 === "number" &&
      Number.isFinite(v.pitch_rise_per_12) &&
      v.pitch_rise_per_12 >= 0 &&
      v.pitch_rise_per_12 <= 24)
  ))
    refuse("invalid_manual_measurement_pitch");
  if (v.area_sq_ft === null && v.pitch_rise_per_12 === null)
    refuse("manual_measurement_required");
  if (
    typeof v.area_basis !== "string" ||
    !["roof_surface", "horizontal_plan", "unknown"].includes(v.area_basis) ||
    (v.area_sq_ft === null && v.area_basis !== "unknown")
  )
    refuse("invalid_manual_measurement_basis");
  if (
    typeof v.method !== "string" ||
    !["tape", "laser", "plans", "drone"].includes(v.method)
  )
    refuse("invalid_manual_measurement_method");
  for (const [key, min] of [
    ["uncertainty", 1],
    ["correction_reason", 3],
  ] as const) {
    const text = v[key];
    if (!(
      text === null ||
      (typeof text === "string" &&
        text.trim().length >= min &&
        text.trim().length <= 500)
    ))
      refuse(`invalid_manual_measurement_${key}`);
  }
  if ("area_id" in target !== (v.correction_reason !== null))
    refuse("manual_measurement_correction_reason_required");
  return {
    ...(v as unknown as ManualMeasurementInput),
    target:
      "area_id" in target
        ? { area_id: target.area_id as string }
        : { new_area_label: (target.new_area_label as string).trim() },
    uncertainty: (v.uncertainty as string | null)?.trim() ?? null,
    correction_reason: (v.correction_reason as string | null)?.trim() ?? null,
  };
}
export async function readManualJob(env: AppEnv, tenant: string, job: string) {
  const row = await env.DB.prepare(
    "SELECT roof_job_id AS id,version,job_number FROM operating_roof_jobs WHERE tenant_id=? AND roof_job_id=?",
  )
    .bind(tenant, job)
    .first<{ id: string; version: number; job_number: string | null }>();
  if (!row) refuse("manual_measurement_job_not_found", 404);
  return row!;
}
export async function readManualHead(env: AppEnv, tenant: string, job: string) {
  return env.DB.prepare(
    "SELECT observation_id,version FROM job_manual_observation_heads WHERE tenant_id=? AND roof_job_id=?",
  )
    .bind(tenant, job)
    .first<{ observation_id: string; version: number }>();
}
export async function observationFromRow(
  row: ObservationRow,
): Promise<ManualObservation> {
  const value = {
    id: row.observation_id,
    job_id: row.roof_job_id,
    area_id: row.area_id,
    area_label: row.area_label,
    revision: row.revision,
    sequence: row.sequence,
    area_sq_ft: row.area_sq_ft,
    area_basis: row.area_basis,
    pitch_rise_per_12: row.pitch_rise_per_12,
    method: row.method,
    uncertainty: row.uncertainty,
    correction_reason: row.correction_reason,
    supersedes_observation_id: row.supersedes_observation_id,
    previous_head_id: row.previous_head_id,
    job_version: row.job_version,
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at,
  };
  if ((await sha256Hex(canonicalJson(value))) !== row.observation_sha256)
    refuse("manual_measurement_evidence_drift", 503);
  return { ...value, sha256: row.observation_sha256 };
}
export async function readManualReceipt(
  env: AppEnv,
  tenant: string,
  job: string,
  actor: string,
  requestId: string,
) {
  const receipt = await env.DB.prepare(
    "SELECT * FROM job_manual_measurement_receipts WHERE tenant_id=? AND request_id=?",
  )
    .bind(tenant, requestId)
    .first<ReceiptRow>();
  if (!receipt) return null;
  if (receipt.roof_job_id !== job || receipt.actor_user_id !== actor)
    refuse("manual_measurement_receipt_not_found", 404);
  let input: ManualMeasurementInput;
  try {
    input = parseManualMeasurementInput(JSON.parse(receipt.input_json));
  } catch {
    return refuse("manual_measurement_evidence_drift", 503);
  }
  if (
    canonicalJson(input) !== receipt.input_json ||
    (await sha256Hex(receipt.input_json)) !== receipt.request_hash
  )
    refuse("manual_measurement_evidence_drift", 503);
  const row = await env.DB.prepare(
    "SELECT * FROM job_manual_observations WHERE tenant_id=? AND roof_job_id=? AND observation_id=?",
  )
    .bind(tenant, job, receipt.observation_id)
    .first<ObservationRow>();
  if (
    !row ||
    row.recorded_by !== actor ||
    row.request_id !== requestId ||
    row.request_hash !== receipt.request_hash ||
    row.recorded_at !== receipt.recorded_at
  )
    refuse("manual_measurement_evidence_drift", 503);
  return {
    request_id: receipt.request_id,
    request_hash: receipt.request_hash,
    observation: await observationFromRow(row!),
  };
}
export async function readManualObservations(
  env: AppEnv,
  tenant: string,
  job: string,
  before?: number,
) {
  const [areas, history] = await Promise.all([
    env.DB.prepare(
      `SELECT o.* FROM job_manual_observations o WHERE o.tenant_id=? AND o.roof_job_id=? AND NOT EXISTS (SELECT 1 FROM job_manual_observations n WHERE n.tenant_id=o.tenant_id AND n.roof_job_id=o.roof_job_id AND n.area_id=o.area_id AND n.revision>o.revision) ORDER BY o.area_label,o.area_id LIMIT 101`,
    )
      .bind(tenant, job)
      .all<ObservationRow>(),
    env.DB.prepare(
      "SELECT * FROM job_manual_observations WHERE tenant_id=? AND roof_job_id=? AND sequence<? ORDER BY sequence DESC LIMIT 26",
    )
      .bind(tenant, job, before ?? 1_000_001)
      .all<ObservationRow>(),
  ]);
  if (areas.results.length > 100)
    refuse("manual_measurement_evidence_drift", 503);
  const items = await Promise.all(
    history.results.slice(0, 25).map(observationFromRow),
  );
  return {
    areas: await Promise.all(areas.results.map(observationFromRow)),
    history: {
      items,
      next_before: history.results.length > 25 ? items.at(-1)!.sequence : null,
    },
  };
}
export async function recordManualMeasurement(
  env: AppEnv,
  actor: { tenantId: string; userId: string },
  jobId: string,
  requestId: string,
  input: ManualMeasurementInput,
) {
  const requestHash = await sha256Hex(canonicalJson(input));
  const replay = async () => {
    const receipt = await readManualReceipt(
      env,
      actor.tenantId,
      jobId,
      actor.userId,
      requestId,
    );
    if (receipt && receipt.request_hash !== requestHash)
      refuse("manual_measurement_idempotency_conflict", 409);
    return receipt;
  };
  const prior = await replay();
  if (prior)
    return {
      version: 1,
      tenant_id: actor.tenantId,
      job_id: jobId,
      receipt: prior,
      replayed: true,
    };
  const job = await readManualJob(env, actor.tenantId, jobId);
  const head = await readManualHead(env, actor.tenantId, jobId);
  if (job.version !== input.expected_job_version)
    refuse("manual_measurement_job_stale", 409);
  if ((head?.observation_id ?? null) !== input.expected_observation_head)
    refuse("manual_measurement_head_stale", 409);
  const predecessor =
    "area_id" in input.target
      ? await env.DB.prepare(
          "SELECT * FROM job_manual_observations WHERE tenant_id=? AND roof_job_id=? AND area_id=? ORDER BY revision DESC LIMIT 1",
        )
          .bind(actor.tenantId, jobId, input.target.area_id)
          .first<ObservationRow>()
      : null;
  if ("area_id" in input.target && !predecessor)
    refuse("manual_measurement_area_not_found", 404);
  if (predecessor) await observationFromRow(predecessor);
  const identity = await sha256Hex(
    canonicalJson({
      tenant: actor.tenantId,
      job: jobId,
      actor: actor.userId,
      request: requestId,
    }),
  );
  const facts = {
    id: `mobs_${identity}`,
    job_id: jobId,
    area_id: predecessor?.area_id ?? `marea_${identity}`,
    area_label:
      predecessor?.area_label ??
      (input.target as { new_area_label: string }).new_area_label,
    revision: (predecessor?.revision ?? 0) + 1,
    sequence: (head?.version ?? 0) + 1,
    area_sq_ft: input.area_sq_ft,
    area_basis: input.area_basis,
    pitch_rise_per_12: input.pitch_rise_per_12,
    method: input.method,
    uncertainty: input.uncertainty,
    correction_reason: input.correction_reason,
    supersedes_observation_id: predecessor?.observation_id ?? null,
    previous_head_id: head?.observation_id ?? null,
    job_version: job.version,
    recorded_by: actor.userId,
    recorded_at: new Date().toISOString(),
  };
  const sha = await sha256Hex(canonicalJson(facts));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO job_manual_observations (observation_id,tenant_id,roof_job_id,area_id,area_label,revision,sequence,area_sq_ft,area_basis,pitch_rise_per_12,method,uncertainty,correction_reason,supersedes_observation_id,previous_head_id,job_version,recorded_by,recorded_at,request_id,request_hash,observation_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        facts.id,
        actor.tenantId,
        jobId,
        facts.area_id,
        facts.area_label,
        facts.revision,
        facts.sequence,
        facts.area_sq_ft,
        facts.area_basis,
        facts.pitch_rise_per_12,
        facts.method,
        facts.uncertainty,
        facts.correction_reason,
        facts.supersedes_observation_id,
        facts.previous_head_id,
        facts.job_version,
        facts.recorded_by,
        facts.recorded_at,
        requestId,
        requestHash,
        sha,
      ),
      env.DB.prepare(
        "INSERT INTO job_manual_measurement_receipts (tenant_id,request_id,roof_job_id,actor_user_id,request_hash,input_json,observation_id,recorded_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        actor.tenantId,
        requestId,
        jobId,
        actor.userId,
        requestHash,
        canonicalJson(input),
        facts.id,
        facts.recorded_at,
      ),
    ]);
  } catch (error) {
    const concurrent = await replay();
    if (concurrent)
      return {
        version: 1,
        tenant_id: actor.tenantId,
        job_id: jobId,
        receipt: concurrent,
        replayed: true,
      };
    const detail = String(error);
    for (const code of [
      "manual_measurement_job_stale",
      "manual_measurement_head_stale",
      "manual_measurement_area_stale",
      "manual_measurement_area_conflict",
    ])
      if (detail.includes(code)) refuse(code, 409);
    if (detail.includes("manual_measurement_record_required"))
      refuse("manual_measurement_record_required", 403);
    refuse("manual_measurement_write_unavailable", 503);
  }
  const receipt = await replay();
  if (!receipt) refuse("manual_measurement_readback_unavailable", 503);
  return {
    version: 1,
    tenant_id: actor.tenantId,
    job_id: jobId,
    receipt,
    replayed: false,
  };
}
