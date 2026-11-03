import type {
  AppEnv,
  AppSessionRecord,
  AppUserRecord,
  AuthRequestContext,
} from "./app-types.ts";
import type { AuthProtocolAdmission } from "./auth-protocol-control.ts";

const CLOCK = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MAX = 9007199254740991;
export interface AuthContextRowV2 {
  tenant_id: string;
  issuer: string;
  context_hash: string;
  generation: number;
  current_session_hash: string | null;
  transition_marker: string;
}
export interface EnrollmentIntentV2 {
  intent_id: string;
  challenge: string;
  base_generation: number;
  issue_floor: number;
}
export interface FencedSessionV2 extends AppSessionRecord {
  auth_protocol: 2;
  auth_issuer: string;
  auth_context_hash: string;
  auth_context_generation: number;
}
export interface GrantV2 extends AppUserRecord {
  token_hash: string;
  issue_sequence: number;
  grant_expires_at: string;
}
const userColumns = `u.user_id,u.tenant_id,u.email_normalized,u.display_name,u.access_role AS role,
  u.access_version,u.frappe_user_id,u.active,u.created_by,u.created_at,u.updated_at`;

export async function readAuthContextV2(
  env: AppEnv,
  tenant: string,
  issuer: string,
  context: string,
): Promise<AuthContextRowV2 | null> {
  return env.DB.prepare(
    `SELECT tenant_id,issuer,context_hash,generation,current_session_hash,transition_marker
    FROM app_auth_contexts WHERE tenant_id=? AND issuer=? AND context_hash=?`,
  )
    .bind(tenant, issuer, context)
    .first<AuthContextRowV2>();
}

export async function findFencedSessionV2(
  env: AppEnv,
  admission: AuthProtocolAdmission,
  tenant: string,
  context: string,
  sessionHash: string,
): Promise<FencedSessionV2 | null> {
  return env.DB.prepare(
    `SELECT ${userColumns},s.session_hash,s.created_at AS session_created_at,
    s.expires_at AS session_expires_at,s.revoked_at,s.device_id,d.device_proof_hash,
    s.auth_protocol,s.auth_issuer,s.auth_context_hash,s.auth_context_generation
    FROM app_sessions s
    JOIN app_users u ON u.tenant_id=s.tenant_id AND u.user_id=s.user_id
    JOIN app_auth_contexts c ON c.tenant_id=s.tenant_id AND c.issuer=s.auth_issuer AND c.context_hash=s.auth_context_hash
    LEFT JOIN app_devices d ON d.tenant_id=s.tenant_id AND d.device_id=s.device_id
    WHERE s.session_hash=? AND s.tenant_id=? AND s.auth_protocol=2 AND s.auth_issuer=?
      AND c.context_hash=? AND c.current_session_hash=s.session_hash
      AND c.generation=s.auth_context_generation AND c.generation>0 AND c.generation<${MAX}
      AND s.revoked_at IS NULL AND s.expires_at>${CLOCK} AND u.active=1
      AND (u.access_role!='field' OR (d.device_id IS NOT NULL AND d.revoked_at IS NULL AND d.user_id=s.user_id))
      AND ${gateSql()}`,
  )
    .bind(
      sessionHash,
      tenant,
      admission.head.issuer,
      context,
      ...gateArgs(admission),
    )
    .first<FencedSessionV2>();
}

export async function beginEnrollmentV2(
  env: AppEnv,
  input: {
    admission: AuthProtocolAdmission;
    tenant: string;
    context: string;
    base: number;
    intent: string;
    challenge: string;
    now: string;
  },
): Promise<EnrollmentIntentV2 | null> {
  const { admission: a, tenant, context, base, intent, challenge, now } = input;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_auth_contexts
      (tenant_id,issuer,context_hash,generation,current_session_hash,transition_marker,created_at,updated_at)
      SELECT ?,?,?,0,NULL,?,?,? WHERE ${gateSql()} AND EXISTS (
        SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND enrollment_open=1)
      ON CONFLICT(tenant_id,issuer,context_hash) DO NOTHING`,
    ).bind(
      tenant,
      a.head.issuer,
      context,
      crypto.randomUUID(),
      now,
      now,
      ...gateArgs(a),
    ),
    env.DB.prepare(
      `INSERT INTO app_auth_enrollment_intents
      (tenant_id,issuer,context_hash,intent_id,challenge,base_generation,issue_floor,created_at)
      SELECT c.tenant_id,c.issuer,c.context_hash,?,?,c.generation,i.sequence,?
      FROM app_auth_contexts c JOIN app_auth_issuance i ON i.issuer=c.issuer AND i.singleton=1
      WHERE c.tenant_id=? AND c.issuer=? AND c.context_hash=? AND c.generation=? AND ${gateSql()}
        AND EXISTS (SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND enrollment_open=1)
      ON CONFLICT(tenant_id,issuer,context_hash,intent_id) DO NOTHING`,
    ).bind(
      intent,
      challenge,
      now,
      tenant,
      a.head.issuer,
      context,
      base,
      ...gateArgs(a),
    ),
  ]);
  const row = await env.DB.prepare(
    `SELECT intent_id,challenge,base_generation,issue_floor
    FROM app_auth_enrollment_intents WHERE tenant_id=? AND issuer=? AND context_hash=? AND intent_id=?`,
  )
    .bind(tenant, a.head.issuer, context, intent)
    .first<EnrollmentIntentV2>();
  const current = await readAuthContextV2(env, tenant, a.head.issuer, context);
  return row?.base_generation === base && current?.generation === base
    ? row
    : null;
}

export async function findGrantV2(
  env: AppEnv,
  a: AuthProtocolAdmission,
  kind: "magic" | "pair",
  tokenHash: string,
  tenant: string,
): Promise<GrantV2 | null> {
  const table = kind === "magic" ? "app_magic_links" : "app_device_pairings";
  return env.DB.prepare(
    `SELECT ${userColumns},g.token_hash,g.issue_sequence,g.expires_at AS grant_expires_at
    FROM ${table} g JOIN app_users u ON u.tenant_id=g.tenant_id AND u.user_id=g.user_id
    WHERE g.token_hash=? AND g.tenant_id=? AND g.auth_protocol=2 AND g.auth_issuer=?
      AND g.consumed_at IS NULL ${kind === "pair" ? "AND g.revoked_at IS NULL" : ""}
      AND g.expires_at>${CLOCK} AND u.active=1
      AND u.access_role ${kind === "pair" ? "=" : "!="} 'field' LIMIT 1`,
  )
    .bind(tokenHash, tenant, a.head.issuer)
    .first<GrantV2>();
}

export async function issueGrantV2(
  env: AppEnv,
  input: {
    admission: AuthProtocolAdmission;
    kind: "magic" | "pair";
    tokenHash: string;
    user: AppUserRecord;
    now: string;
    expiresAt: string;
    request: AuthRequestContext;
    actor?: FencedSessionV2;
  },
): Promise<void> {
  const {
    admission: a,
    user,
    kind,
    tokenHash,
    now,
    expiresAt,
    request,
    actor,
  } = input;
  if (kind === "pair" && !actor) throw new Error("auth_issuer_required");
  const marker = crypto.randomUUID();
  const table = kind === "magic" ? "app_magic_links" : "app_device_pairings";
  const markerSql =
    "EXISTS (SELECT 1 FROM app_auth_issuance WHERE singleton=1 AND execution_marker=?)";
  // Alias-free exact actor predicates are appended below; no client-provided user/role is a grant.
  const exactActor = actor ? ` AND ${actorSql()}` : "";
  const batch = [
    env.DB.prepare(
      `UPDATE app_auth_issuance SET sequence=sequence+1,execution_marker=?
    WHERE singleton=1 AND issuer=? AND sequence<${MAX} AND ${gateSql()}
      AND ${liveUserSql()} AND ${kind === "pair" ? "?='field'" : "?!='field'"}${exactActor}`,
    ).bind(
      marker,
      a.head.issuer,
      ...gateArgs(a),
      ...liveUserArgs(user),
      user.role,
      ...(actor ? actorArgs(actor) : []),
    ),
    issuanceAssertion(env),
  ];
  // Keep the old revoke+insert atomicity. An old producer's rejected insert rolls its revoke back.
  if (kind === "pair")
    batch.push(
      env.DB.prepare(
        `UPDATE app_device_pairings SET revoked_at=?
    WHERE tenant_id=? AND user_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND ${markerSql}`,
      ).bind(now, user.tenant_id, user.user_id, marker),
    );
  if (kind === "magic") {
    batch.push(
      env.DB.prepare(
        `INSERT INTO app_magic_links
      (token_hash,user_id,tenant_id,created_at,expires_at,consumed_at,request_ip_hash,request_user_agent_hash,
       auth_protocol,auth_issuer,issue_sequence,claim_marker)
      SELECT ?,?,?,?,?,NULL,?,?,2,?,sequence,NULL FROM app_auth_issuance
      WHERE singleton=1 AND execution_marker=?
      ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,tenant_id=excluded.tenant_id,
        created_at=excluded.created_at,expires_at=excluded.expires_at,consumed_at=NULL,
        request_ip_hash=excluded.request_ip_hash,request_user_agent_hash=excluded.request_user_agent_hash,
        auth_protocol=2,auth_issuer=excluded.auth_issuer,issue_sequence=excluded.issue_sequence,claim_marker=NULL`,
      ).bind(
        tokenHash,
        user.user_id,
        user.tenant_id,
        now,
        expiresAt,
        request.ip_hash,
        request.user_agent_hash,
        a.head.issuer,
        marker,
      ),
    );
  } else {
    batch.push(
      env.DB.prepare(
        `INSERT INTO app_device_pairings
      (token_hash,tenant_id,user_id,issued_by_user_id,created_at,expires_at,consumed_at,revoked_at,
       issued_ip_hash,issued_user_agent_hash,auth_protocol,auth_issuer,issue_sequence,claim_marker)
      SELECT ?,?,?,?,?,?,NULL,NULL,?,?,2,?,sequence,NULL FROM app_auth_issuance
      WHERE singleton=1 AND execution_marker=?`,
      ).bind(
        tokenHash,
        user.tenant_id,
        user.user_id,
        actor!.user_id,
        now,
        expiresAt,
        request.ip_hash,
        request.user_agent_hash,
        a.head.issuer,
        marker,
      ),
    );
  }
  batch.push(issuanceAssertion(env));
  batch.push(
    env.DB.prepare(
      `INSERT INTO app_auth_audit
    (created_at,tenant_id,user_id,event,outcome,ip_hash,user_agent_hash,detail_code)
    SELECT ?,?,?,?,?,?,?,? WHERE ${markerSql}`,
    ).bind(
      now,
      user.tenant_id,
      user.user_id,
      kind === "pair" ? "device_pairing_issue" : "magic_link_request",
      "issued",
      request.ip_hash,
      request.user_agent_hash,
      `v2:${marker}`,
      marker,
    ),
  );
  batch.push(issuanceAssertion(env));
  batch.push(
    env.DB.prepare(
      `UPDATE app_auth_issuance SET execution_marker=CASE WHEN EXISTS (
      SELECT 1 FROM ${table} g WHERE g.token_hash=? AND g.tenant_id=? AND g.user_id=?
        AND g.auth_issuer=? AND g.issue_sequence=app_auth_issuance.sequence AND g.consumed_at IS NULL
        AND g.expires_at>${CLOCK}) AND ${liveUserSql()}${exactActor}
      THEN execution_marker ELSE NULL END WHERE singleton=1 AND execution_marker=?`,
    ).bind(
      tokenHash,
      user.tenant_id,
      user.user_id,
      a.head.issuer,
      ...liveUserArgs(user),
      ...(actor ? actorArgs(actor) : []),
      marker,
    ),
  );
  const result = await env.DB.batch(batch);
  if (changes(result[result.length - 1]) !== 1)
    throw new Error("auth_grant_unconfirmed");
}

export interface AuthTransitionV2 {
  admission: AuthProtocolAdmission;
  tenant: string;
  context: string;
  base: number;
  kind: "magic" | "pair" | "recovery" | "logout";
  user: AppUserRecord;
  oldSession?: FencedSessionV2;
  grant?: GrantV2;
  intent?: string;
  challenge?: string;
  newSessionHash: string | null;
  deviceId: string | null;
  deviceProofHash: string | null;
  now: string;
  expiresAt: string;
  request: AuthRequestContext;
}

export async function transitionAuthV2(
  env: AppEnv,
  input: AuthTransitionV2,
): Promise<boolean> {
  const {
    admission: a,
    tenant,
    context,
    base,
    kind,
    user,
    oldSession,
    grant,
    intent,
    challenge,
    newSessionHash,
    deviceId,
    deviceProofHash,
    now,
    expiresAt,
    request,
  } = input;
  if (
    !Number.isSafeInteger(base) ||
    base < 0 ||
    base >= MAX ||
    user.tenant_id !== tenant ||
    ((kind === "recovery" || kind === "logout") && !oldSession) ||
    ((kind === "magic" || kind === "pair") &&
      (!grant || !intent || !challenge)) ||
    (kind === "magic" && user.role === "field") ||
    (kind === "pair" && user.role !== "field") ||
    (oldSession &&
      (oldSession.auth_context_hash !== context ||
        oldSession.auth_issuer !== a.head.issuer ||
        oldSession.auth_context_generation !== base ||
        oldSession.tenant_id !== tenant))
  )
    return false;
  const marker = crypto.randomUUID();
  const winner = `EXISTS (SELECT 1 FROM app_auth_contexts WHERE tenant_id=? AND issuer=?
    AND context_hash=? AND generation=? AND transition_marker=?)`;
  const winArgs = [tenant, a.head.issuer, context, base + 1, marker];
  const table = kind === "pair" ? "app_device_pairings" : "app_magic_links";
  const grantPredicate = grant
    ? `EXISTS (
    SELECT 1 FROM ${table} g JOIN app_auth_enrollment_intents i
      ON i.tenant_id=g.tenant_id AND i.issuer=g.auth_issuer
     WHERE g.token_hash=? AND g.tenant_id=? AND g.user_id=? AND g.auth_protocol=2 AND g.auth_issuer=?
       AND g.issue_sequence=? AND g.expires_at>${CLOCK} AND g.consumed_at IS NULL
       ${kind === "pair" ? "AND g.revoked_at IS NULL" : ""}
       AND i.context_hash=? AND i.intent_id=? AND i.challenge=? AND i.base_generation=?
       AND g.issue_sequence>i.issue_floor)`
    : "";
  const grantArgs = grant
    ? [
        grant.token_hash,
        tenant,
        user.user_id,
        a.head.issuer,
        grant.issue_sequence,
        context,
        intent!,
        challenge!,
        base,
      ]
    : [];
  const credentialSql = oldSession ? liveSessionSql() : grantPredicate;
  const credentialArgs = oldSession ? liveSessionArgs(oldSession) : grantArgs;
  const assertion = () =>
    env.DB.prepare(
      `UPDATE app_auth_contexts
    SET transition_marker=CASE WHEN changes()=1 THEN transition_marker ELSE NULL END
    WHERE tenant_id=? AND issuer=? AND context_hash=?`,
    ).bind(tenant, a.head.issuer, context);
  const batch = [
    env.DB.prepare(
      `UPDATE app_auth_contexts SET generation=generation+1,
    current_session_hash=?,transition_marker=?,updated_at=?
    WHERE tenant_id=? AND issuer=? AND context_hash=? AND generation=? AND generation<${MAX}
      AND ${gateSql()} AND ${liveUserSql()} AND ${credentialSql}
      ${grant ? "AND EXISTS (SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND enrollment_open=1)" : ""}`,
    ).bind(
      newSessionHash,
      marker,
      now,
      tenant,
      a.head.issuer,
      context,
      base,
      ...gateArgs(a),
      ...liveUserArgs(user),
      ...credentialArgs,
    ),
    assertion(),
  ];
  if (grant) {
    batch.push(
      env.DB.prepare(
        `UPDATE ${table} SET consumed_at=?,claim_marker=?
      WHERE token_hash=? AND tenant_id=? AND user_id=? AND consumed_at IS NULL AND expires_at>${CLOCK}
        ${kind === "pair" ? "AND revoked_at IS NULL" : ""} AND ${winner}`,
      ).bind(now, marker, grant.token_hash, tenant, user.user_id, ...winArgs),
      assertion(),
    );
  }
  if (kind === "pair") {
    batch.push(
      env.DB.prepare(
        `INSERT INTO app_devices
      (device_id,tenant_id,user_id,device_proof_hash,paired_at,last_seen_at,revoked_at,revoked_by_user_id,created_ip_hash,created_user_agent_hash)
      SELECT ?,?,?,?,?,?,NULL,NULL,?,? WHERE ${winner}`,
      ).bind(
        deviceId,
        tenant,
        user.user_id,
        deviceProofHash,
        now,
        now,
        request.ip_hash,
        request.user_agent_hash,
        ...winArgs,
      ),
      assertion(),
    );
  }
  if (kind !== "logout") {
    batch.push(
      env.DB.prepare(
        `INSERT INTO app_sessions
      (session_hash,user_id,tenant_id,created_at,expires_at,revoked_at,last_seen_at,created_ip_hash,
       created_user_agent_hash,device_id,auth_protocol,auth_issuer,auth_context_hash,auth_context_generation)
      SELECT ?,?,?,?,?,NULL,?,?,?,?,2,?,?,? WHERE ${winner}`,
      ).bind(
        newSessionHash,
        user.user_id,
        tenant,
        now,
        expiresAt,
        now,
        request.ip_hash,
        request.user_agent_hash,
        deviceId,
        a.head.issuer,
        context,
        base + 1,
        ...winArgs,
      ),
      assertion(),
    );
  }
  batch.push(
    env.DB.prepare(
      `UPDATE app_sessions SET revoked_at=?
    WHERE tenant_id=? AND auth_issuer=? AND auth_context_hash=? AND revoked_at IS NULL
      ${newSessionHash ? "AND session_hash!=?" : ""} AND ${winner}`,
    ).bind(
      now,
      tenant,
      a.head.issuer,
      context,
      ...(newSessionHash ? [newSessionHash] : []),
      ...winArgs,
    ),
  );
  batch.push(
    env.DB.prepare(
      `INSERT INTO app_auth_audit
    (created_at,tenant_id,user_id,event,outcome,ip_hash,user_agent_hash,detail_code)
    SELECT ?,?,?,?,?,?,?,? WHERE ${winner}`,
    ).bind(
      now,
      tenant,
      user.user_id,
      kind === "logout" ? "session_logout" : `v2_${kind}`,
      kind === "logout" ? "revoked" : "session_created",
      request.ip_hash,
      request.user_agent_hash,
      `v2:${marker}`,
      ...winArgs,
    ),
    assertion(),
  );
  const resultPointer =
    kind === "logout"
      ? "current_session_hash IS NULL"
      : `EXISTS (
    SELECT 1 FROM app_sessions s LEFT JOIN app_devices d ON d.tenant_id=s.tenant_id AND d.device_id=s.device_id
     WHERE s.session_hash=app_auth_contexts.current_session_hash AND s.session_hash=?
       AND s.tenant_id=app_auth_contexts.tenant_id AND s.user_id=? AND s.auth_protocol=2
       AND s.auth_issuer=app_auth_contexts.issuer AND s.auth_context_hash=app_auth_contexts.context_hash
       AND s.auth_context_generation=app_auth_contexts.generation AND s.revoked_at IS NULL AND s.expires_at>${CLOCK}
       AND s.expires_at=? AND (?!='field' OR (d.revoked_at IS NULL AND d.user_id=s.user_id AND d.device_id=? AND d.device_proof_hash=?)))`;
  const claimed = grant
    ? ` AND EXISTS (SELECT 1 FROM ${table} WHERE token_hash=? AND claim_marker=?
    AND consumed_at IS NOT NULL AND expires_at>${CLOCK})`
    : "";
  batch.push(
    env.DB.prepare(
      `UPDATE app_auth_contexts SET transition_marker=CASE WHEN
      ${resultPointer} AND ${liveUserSql()} AND ${gateSql()}${claimed}
      THEN transition_marker ELSE NULL END
    WHERE tenant_id=? AND issuer=? AND context_hash=? AND generation=? AND transition_marker=?`,
    ).bind(
      ...(kind === "logout"
        ? []
        : [
            newSessionHash,
            user.user_id,
            expiresAt,
            user.role,
            deviceId,
            deviceProofHash,
          ]),
      ...liveUserArgs(user),
      ...gateArgs(a),
      ...(grant ? [grant.token_hash, marker] : []),
      ...winArgs,
    ),
    assertion(),
  );
  const result = await env.DB.batch(batch);
  return changes(result[0]) === 1 && changes(result[result.length - 2]) === 1;
}

function gateSql(): string {
  return `EXISTS (SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND protocol_floor=2
    AND mode='active' AND issuer=? AND activation_id=? AND database_identity=? AND control_revision=?)`;
}
function gateArgs(a: AuthProtocolAdmission): (string | number)[] {
  return [
    a.head.issuer,
    a.head.activationId,
    a.head.databaseIdentity,
    a.head.controlRevision,
  ];
}
function liveUserSql(): string {
  return "EXISTS (SELECT 1 FROM app_users WHERE tenant_id=? AND user_id=? AND active=1 AND access_role=? AND access_version=? AND updated_at=?)";
}
function liveUserArgs(user: AppUserRecord): unknown[] {
  return [
    user.tenant_id,
    user.user_id,
    user.role,
    user.access_version,
    user.updated_at,
  ];
}
function liveSessionSql(): string {
  return `EXISTS (SELECT 1 FROM app_sessions s JOIN app_auth_contexts c
    ON c.tenant_id=s.tenant_id AND c.issuer=s.auth_issuer AND c.context_hash=s.auth_context_hash
    LEFT JOIN app_devices d ON d.tenant_id=s.tenant_id AND d.device_id=s.device_id
    WHERE s.session_hash=? AND s.tenant_id=? AND s.user_id=? AND s.auth_protocol=2 AND s.auth_issuer=?
      AND s.auth_context_hash=? AND s.auth_context_generation=? AND c.generation=s.auth_context_generation
      AND c.current_session_hash=s.session_hash AND s.revoked_at IS NULL AND s.expires_at>${CLOCK}
      AND s.expires_at=? AND s.device_id IS ?
      AND (?!='field' OR (d.device_id IS NOT NULL AND d.revoked_at IS NULL AND d.user_id=s.user_id AND d.device_proof_hash=?)))`;
}
function liveSessionArgs(s: FencedSessionV2): unknown[] {
  return [
    s.session_hash,
    s.tenant_id,
    s.user_id,
    s.auth_issuer,
    s.auth_context_hash,
    s.auth_context_generation,
    s.session_expires_at,
    s.device_id,
    s.role,
    s.device_proof_hash,
  ];
}
function actorSql(): string {
  return `${liveSessionSql()} AND ? IN ('owner','ops') AND ${liveUserSql()}`;
}
function actorArgs(s: FencedSessionV2): unknown[] {
  return [...liveSessionArgs(s), s.role, ...liveUserArgs(s)];
}
function issuanceAssertion(env: AppEnv): D1PreparedStatement {
  return env.DB.prepare(`UPDATE app_auth_issuance
    SET execution_marker=CASE WHEN changes()=1 THEN execution_marker ELSE NULL END WHERE singleton=1`);
}
function changes(result: unknown): number {
  return Number(
    (result as { meta?: { changes?: number } })?.meta?.changes ?? 0,
  );
}
