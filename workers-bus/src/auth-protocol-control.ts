import { readControlObject } from "../../shared/auth-control-s3.mjs";
import {
  canonicalV2,
  type AuthControlHeadV2,
} from "../../shared/auth-protocol-v2.mjs";
import type { AppEnv } from "./app-types.ts";

export interface AuthProtocolMirror {
  protocol_floor: number;
  mode: string;
  control_revision: number;
  issuer: string | null;
  activation_id: string | null;
  database_identity: string | null;
  enrollment_open: number;
}
export interface AuthProtocolAdmission {
  head: AuthControlHeadV2;
  actualVersion: string;
  mirror: AuthProtocolMirror;
  mode: "staged" | "active";
}

export async function admitAuthProtocol(
  env: AppEnv,
): Promise<AuthProtocolAdmission> {
  const object = await readControlObject({
    accountId: env.AUTH_CONTROL_ACCOUNT_ID ?? "",
    bucket: env.AUTH_CONTROL_BUCKET ?? "",
    key: env.AUTH_CONTROL_KEY ?? "",
    accessKeyId: env.AUTH_CONTROL_READ_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.AUTH_CONTROL_READ_SECRET_ACCESS_KEY ?? "",
  });
  if (!object) throw new Error("auth_control_unavailable");
  const { head } = object;
  const actualVersion = env.CF_VERSION_METADATA?.id ?? "";
  const binding = head.allowedProducerBindings.find(
    (item) => item.versionId === actualVersion,
  );
  if (
    !["qa", "production"].includes(env.AUTH_CONTROL_ENVIRONMENT ?? "") ||
    !binding ||
    binding.protocol !== 2 ||
    head.databaseIdentity !== env.AUTH_DATABASE_IDENTITY ||
    head.mode === "closed" ||
    (head.mode === "active" &&
      head.qualificationReceiptHash === null &&
      (env.AUTH_CONTROL_ENVIRONMENT !== "qa" ||
        env.AGENT_DATA_CLASS !== "synthetic"))
  ) {
    throw new Error("auth_control_unavailable");
  }
  const mirror = await env.DB.prepare(
    `SELECT protocol_floor,mode,control_revision,issuer,activation_id,database_identity,enrollment_open
       FROM app_auth_protocol WHERE singleton=1`,
  )
    .bind()
    .first<AuthProtocolMirror>();
  if (
    !mirror ||
    mirror.issuer !== head.issuer ||
    mirror.activation_id !== head.activationId ||
    mirror.database_identity !== head.databaseIdentity ||
    mirror.protocol_floor !== head.minProducerProtocol ||
    mirror.mode !== head.mode ||
    mirror.control_revision !== head.controlRevision ||
    (head.mode === "staged" && mirror.enrollment_open !== 0)
  )
    throw new Error("auth_control_unavailable");
  return { head, actualVersion, mirror, mode: head.mode };
}

export async function recheckAuthProtocol(
  env: AppEnv,
  previous: AuthProtocolAdmission,
): Promise<AuthProtocolAdmission> {
  const current = await admitAuthProtocol(env);
  if (
    current.actualVersion !== previous.actualVersion ||
    canonicalV2(current.head) !== canonicalV2(previous.head)
  ) {
    throw new Error("auth_control_changed");
  }
  return current;
}

export function enrollmentOpen(
  env: AppEnv,
  admission: AuthProtocolAdmission,
): boolean {
  // P1 commits false in every serving configuration. Qualification fixtures are explicit and
  // are not a completed producer qualification or supported-client activation.
  return (
    env.AUTH_RECOVERY_ENROLLMENT_ENABLED === "true" &&
    admission.mode === "active" &&
    admission.mirror.enrollment_open === 1 &&
    (env.AUTH_CONTROL_ENVIRONMENT === "qa" ||
      (env.AUTH_CONTROL_ENVIRONMENT === "production" &&
        admission.head.qualificationReceiptHash !== null))
  );
}

export function unconfirmedAuthResponse(
  reason:
    | "auth_control_unavailable"
    | "auth_protocol_unconfirmed" = "auth_control_unavailable",
): Response {
  return Response.json(
    { error: reason },
    {
      status: 503,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
