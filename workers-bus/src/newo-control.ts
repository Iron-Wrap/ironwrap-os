import {
  NewoApiClient,
  newoClientConfigFromEnv,
  type NewoAgentActorInput,
  type NewoAgentMessageInput,
  type NewoChatMessageInput,
  type NewoIncomingWebhookInput,
  type NewoJson,
  type NewoOutgoingWebhookInput,
  type NewoSessionUpdate,
  type NewoUserActorInput,
  type NewoUserActorUpdate,
} from "./newo-client.ts";
import {
  assertEffectLedgerReady,
  EffectRuntimeError,
  runExternalEffect,
} from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  approveNewoControlAction as approveStoredAction,
  claimNewoControlExecution,
  completeNewoControlAction,
  createNewoControlPreview,
  failNewoControlAction,
  getNewoControlAction,
} from "./newo-control-store.ts";
import { recordAudit } from "./store.ts";

const CONTROL_SCHEMA_VERSION = "newo.control.v1";
const RECEIPT_PREFIX = "newor1";
const DEFAULT_TTL_SECONDS = 600;
const MAX_RESULT_BYTES = 64 * 1024;

export const NEWO_CONTROL_OPERATIONS = [
  "auth.token.revoke",
  "agent_actor.create",
  "user_actor.create",
  "user_actor.get_or_create",
  "user_actor.update",
  "user_actor.delete",
  "chat.user.send",
  "conversation.agent_message.send",
  "session.update",
  "webhook.outgoing.create",
  "webhook.outgoing.update",
  "webhook.outgoing.delete",
  "webhook.incoming.create",
  "webhook.incoming.update",
  "webhook.incoming.delete",
] as const;

export type NewoControlOperation = (typeof NEWO_CONTROL_OPERATIONS)[number];

export type NewoControlAction =
  | { operation: "auth.token.revoke"; args: Record<string, never> }
  | { operation: "agent_actor.create"; args: NewoAgentActorInput }
  | { operation: "user_actor.create"; args: NewoUserActorInput }
  | { operation: "user_actor.get_or_create"; args: NewoUserActorInput }
  | { operation: "user_actor.update"; args: { actor_id: string; input: NewoUserActorUpdate } }
  | { operation: "user_actor.delete"; args: { actor_id: string } }
  | { operation: "chat.user.send"; args: { user_actor_id: string; input: NewoChatMessageInput } }
  | { operation: "conversation.agent_message.send"; args: NewoAgentMessageInput }
  | { operation: "session.update"; args: { session_id: string; input: NewoSessionUpdate } }
  | { operation: "webhook.outgoing.create"; args: NewoOutgoingWebhookInput }
  | {
    operation: "webhook.outgoing.update";
    args: { webhook_id: string; input: Partial<NewoOutgoingWebhookInput> };
  }
  | { operation: "webhook.outgoing.delete"; args: { webhook_id: string } }
  | { operation: "webhook.incoming.create"; args: NewoIncomingWebhookInput }
  | {
    operation: "webhook.incoming.update";
    args: { webhook_id: string; input: Partial<NewoIncomingWebhookInput> };
  }
  | { operation: "webhook.incoming.delete"; args: { webhook_id: string } };

export interface NewoToolReceipt {
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  action_id: string;
  operation: NewoControlOperation;
  args_hash: string;
  status: "previewed" | "approved" | "completed";
  expires_at?: string;
  dry_run_receipt?: string;
  approval_receipt?: string;
  approved_by?: string;
  provider_result?: NewoJson;
}

interface DryRunReceiptPayload {
  receipt_type: "dry_run";
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  action_id: string;
  operation: NewoControlOperation;
  args_hash: string;
  requested_by: string;
  issued_at: string;
  expires_at: string;
}

interface ApprovalReceiptPayload {
  receipt_type: "approval";
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  action_id: string;
  operation: NewoControlOperation;
  args_hash: string;
  dry_run_receipt_hash: string;
  approved_by: string;
  reason: string;
  issued_at: string;
  expires_at: string;
}

type ReceiptPayload = DryRunReceiptPayload | ApprovalReceiptPayload;

export class NewoControlError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "NewoControlError";
    this.status = status;
    this.code = code;
  }
}

export async function previewNewoControlAction(
  env: Env,
  body: unknown,
  now = new Date(),
): Promise<NewoToolReceipt & { preview: ReturnType<typeof previewPolicy> }> {
  requireSigningSecret(env);
  const request = plainObject(body, "body");
  exactKeys(request, ["action", "requested_by"], [], "body");
  const action = parseNewoControlAction(request.action);
  const requestedBy = boundedText(request.requested_by, 3, 128, "requested_by");
  const actionId = crypto.randomUUID();
  const argsHash = await actionHash(action);
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + receiptTtlSeconds(env) * 1000).toISOString();
  const payload: DryRunReceiptPayload = {
    receipt_type: "dry_run",
    schema_version: CONTROL_SCHEMA_VERSION,
    action_id: actionId,
    operation: action.operation,
    args_hash: argsHash,
    requested_by: requestedBy,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const dryRunReceipt = await signReceipt(requireSigningSecret(env), payload);
  const receiptHash = await sha256Hex(dryRunReceipt);

  await createNewoControlPreview(env, {
    action_id: actionId,
    operation: action.operation,
    args_hash: argsHash,
    args_json: canonicalJson(action.args),
    requested_by: requestedBy,
    dry_run_receipt_hash: receiptHash,
    dry_run_expires_at: expiresAt,
    created_at: issuedAt,
    updated_at: issuedAt,
  });
  await recordAudit(env, {
    automation: "newo_control",
    trigger: "admin",
    envelope_id: null,
    action: `preview:${action.operation}`,
    result: "ok",
    run_id: actionId,
    reason: "Exact-argument Newo control preview",
  });

  return {
    schema_version: CONTROL_SCHEMA_VERSION,
    action_id: actionId,
    operation: action.operation,
    args_hash: argsHash,
    status: "previewed",
    expires_at: expiresAt,
    dry_run_receipt: dryRunReceipt,
    preview: previewPolicy(action),
  };
}

export async function approveNewoControlAction(
  env: Env,
  body: unknown,
  now = new Date(),
): Promise<NewoToolReceipt> {
  const request = plainObject(body, "body");
  exactKeys(request, ["dry_run_receipt", "approved_by", "reason"], [], "body");
  const dryRunReceipt = boundedText(request.dry_run_receipt, 32, 16_384, "dry_run_receipt");
  const approvedBy = boundedText(request.approved_by, 3, 128, "approved_by");
  const reason = boundedText(request.reason, 10, 500, "reason");
  const secret = requireSigningSecret(env);
  const dryPayload = await verifyReceipt(secret, dryRunReceipt, "dry_run", now);
  const record = await getNewoControlAction(env, dryPayload.action_id);
  const dryRunReceiptHash = await sha256Hex(dryRunReceipt);
  if (!record || record.status !== "previewed" || record.operation !== dryPayload.operation ||
    record.args_hash !== dryPayload.args_hash || record.dry_run_receipt_hash !== dryRunReceiptHash) {
    throw new NewoControlError(409, "newo_control_preview_conflict");
  }

  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + receiptTtlSeconds(env) * 1000).toISOString();
  const approvalPayload: ApprovalReceiptPayload = {
    receipt_type: "approval",
    schema_version: CONTROL_SCHEMA_VERSION,
    action_id: dryPayload.action_id,
    operation: dryPayload.operation,
    args_hash: dryPayload.args_hash,
    dry_run_receipt_hash: dryRunReceiptHash,
    approved_by: approvedBy,
    reason,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const approvalReceipt = await signReceipt(secret, approvalPayload);
  const approvalReceiptHash = await sha256Hex(approvalReceipt);
  const approved = await approveStoredAction(env, {
    actionId: dryPayload.action_id,
    approvedBy,
    approvalReason: reason,
    approvalReceiptHash,
    approvalExpiresAt: expiresAt,
    now: issuedAt,
  });
  if (!approved) throw new NewoControlError(409, "newo_control_preview_consumed");
  await recordAudit(env, {
    automation: "newo_control",
    trigger: "admin",
    envelope_id: null,
    action: `approve:${dryPayload.operation}`,
    result: "ok",
    run_id: dryPayload.action_id,
    approved_by: approvedBy,
    reason,
  });
  return {
    schema_version: CONTROL_SCHEMA_VERSION,
    action_id: dryPayload.action_id,
    operation: dryPayload.operation,
    args_hash: dryPayload.args_hash,
    status: "approved",
    expires_at: expiresAt,
    approval_receipt: approvalReceipt,
    approved_by: approvedBy,
  };
}

export async function executeApprovedNewoControlAction(
  env: Env,
  body: unknown,
  now = new Date(),
): Promise<NewoToolReceipt> {
  const request = plainObject(body, "body");
  exactKeys(request, ["dry_run_receipt", "approval_receipt"], [], "body");
  const dryRunReceipt = boundedText(request.dry_run_receipt, 32, 16_384, "dry_run_receipt");
  const approvalReceipt = boundedText(request.approval_receipt, 32, 16_384, "approval_receipt");
  const secret = requireSigningSecret(env);
  const [dryPayload, approvalPayload] = await Promise.all([
    verifyReceipt(secret, dryRunReceipt, "dry_run", now),
    verifyReceipt(secret, approvalReceipt, "approval", now),
  ]);
  const dryRunReceiptHash = await sha256Hex(dryRunReceipt);
  if (approvalPayload.action_id !== dryPayload.action_id ||
    approvalPayload.operation !== dryPayload.operation ||
    approvalPayload.args_hash !== dryPayload.args_hash ||
    approvalPayload.dry_run_receipt_hash !== dryRunReceiptHash) {
    throw new NewoControlError(409, "newo_control_receipt_binding_mismatch");
  }
  const approvalReceiptHash = await sha256Hex(approvalReceipt);
  const record = await getNewoControlAction(env, dryPayload.action_id);
  if (!record || record.status !== "approved" || record.operation !== dryPayload.operation ||
    record.args_hash !== dryPayload.args_hash || record.dry_run_receipt_hash !== dryRunReceiptHash ||
    record.approval_receipt_hash !== approvalReceiptHash ||
    record.approved_by !== approvalPayload.approved_by) {
    throw new NewoControlError(409, "newo_control_approval_consumed_or_conflicted");
  }
  const action = parseNewoControlAction({
    operation: record.operation,
    args: parseStoredJson(record.args_json),
  });
  enforceExecutionPolicy(env, action);

  const claimedAt = now.toISOString();
  const claimed = await claimNewoControlExecution(env, {
    actionId: dryPayload.action_id,
    dryRunReceiptHash,
    approvalReceiptHash,
    now: claimedAt,
  });
  if (!claimed) throw new NewoControlError(409, "newo_control_approval_consumed_or_expired");

  try {
    const providerResult = await executeNewoMutationThroughRuntime(
      env,
      action,
      approvalPayload.approved_by,
      approvalReceiptHash,
      approvalPayload.expires_at,
      now,
    );
    const responseJson = canonicalJson(providerResult);
    const responseHash = await sha256Hex(responseJson);
    const completedAt = new Date().toISOString();
    const finalized = await completeNewoControlAction(
      env,
      dryPayload.action_id,
      responseHash,
      boundedStoredResult(responseJson, responseHash),
      completedAt,
    );
    if (!finalized) throw new Error("newo_control_finalize_conflict");
    await recordAudit(env, {
      automation: "newo_control",
      trigger: "admin",
      envelope_id: null,
      action: `execute:${action.operation}`,
      result: "ok",
      run_id: dryPayload.action_id,
      approved_by: approvalPayload.approved_by,
      reason: approvalPayload.reason,
    });
    return {
      schema_version: CONTROL_SCHEMA_VERSION,
      action_id: dryPayload.action_id,
      operation: dryPayload.operation,
      args_hash: dryPayload.args_hash,
      status: "completed",
      approved_by: approvalPayload.approved_by,
      provider_result: providerResult,
    };
  } catch (error) {
    // The universal ledger deliberately keeps an uncertain provider outcome
    // reconcilable. Do not collapse it into a local "failed" control receipt;
    // the owner surface must see the external uncertainty and reconcile it
    // before another attempt can be authorized.
    if (error instanceof EffectRuntimeError && error.code === "effect_unknown_requires_reconciliation") {
      await recordAudit(env, {
        automation: "newo_control",
        trigger: "admin",
        envelope_id: null,
        action: `execute:${action.operation}`,
        // The existing control-audit schema has ok/error only; preserve the
        // universal unknown state in the error code while leaving the control
        // action executing for reconciliation instead of marking it failed.
        result: "error",
        error: `unknown:${error.code}`,
        recovery_owner: env.OWNER_ALERT_EMAIL,
        run_id: dryPayload.action_id,
        approved_by: approvalPayload.approved_by,
        reason: approvalPayload.reason,
      }).catch(() => {});
      throw error;
    }
    const failure = safeFailure(error);
    await failNewoControlAction(env, dryPayload.action_id, failure, new Date().toISOString()).catch(() => {});
    await recordAudit(env, {
      automation: "newo_control",
      trigger: "admin",
      envelope_id: null,
      action: `execute:${action.operation}`,
      result: "error",
      error: failure,
      recovery_owner: env.OWNER_ALERT_EMAIL,
      run_id: dryPayload.action_id,
      approved_by: approvalPayload.approved_by,
      reason: approvalPayload.reason,
    }).catch(() => {});
    throw error;
  }
}

export function parseNewoControlAction(value: unknown): NewoControlAction {
  const root = plainObject(value, "action");
  exactKeys(root, ["operation", "args"], [], "action");
  const operation = boundedText(root.operation, 3, 80, "operation") as NewoControlOperation;
  const args = plainObject(root.args, "args");
  switch (operation) {
    case "auth.token.revoke":
      exactKeys(args, [], [], "args");
      return { operation, args: {} };
    case "agent_actor.create":
      return { operation, args: parseAgentActor(args) };
    case "user_actor.create":
    case "user_actor.get_or_create":
      return { operation, args: parseUserActor(args) };
    case "user_actor.update": {
      exactKeys(args, ["actor_id", "input"], [], "args");
      return {
        operation,
        args: { actor_id: providerId(args.actor_id, "actor_id"), input: parseUserActorUpdate(args.input) },
      };
    }
    case "user_actor.delete":
      exactKeys(args, ["actor_id"], [], "args");
      return { operation, args: { actor_id: providerId(args.actor_id, "actor_id") } };
    case "chat.user.send": {
      exactKeys(args, ["user_actor_id", "input"], [], "args");
      return {
        operation,
        args: {
          user_actor_id: providerId(args.user_actor_id, "user_actor_id"),
          input: parseChatMessage(args.input),
        },
      };
    }
    case "conversation.agent_message.send":
      return { operation, args: parseAgentMessage(args) };
    case "session.update": {
      exactKeys(args, ["session_id", "input"], [], "args");
      return {
        operation,
        args: { session_id: providerId(args.session_id, "session_id"), input: parseSessionUpdate(args.input) },
      };
    }
    case "webhook.outgoing.create":
      return { operation, args: parseOutgoingWebhook(args, false) as NewoOutgoingWebhookInput };
    case "webhook.outgoing.update": {
      exactKeys(args, ["webhook_id", "input"], [], "args");
      return {
        operation,
        args: {
          webhook_id: providerId(args.webhook_id, "webhook_id"),
          input: parseOutgoingWebhook(args.input, true),
        },
      };
    }
    case "webhook.outgoing.delete":
      exactKeys(args, ["webhook_id"], [], "args");
      return { operation, args: { webhook_id: providerId(args.webhook_id, "webhook_id") } };
    case "webhook.incoming.create":
      return { operation, args: parseIncomingWebhook(args, false) as NewoIncomingWebhookInput };
    case "webhook.incoming.update": {
      exactKeys(args, ["webhook_id", "input"], [], "args");
      return {
        operation,
        args: {
          webhook_id: providerId(args.webhook_id, "webhook_id"),
          input: parseIncomingWebhook(args.input, true),
        },
      };
    }
    case "webhook.incoming.delete":
      exactKeys(args, ["webhook_id"], [], "args");
      return { operation, args: { webhook_id: providerId(args.webhook_id, "webhook_id") } };
    default:
      throw new NewoControlError(400, "newo_control_operation_unsupported");
  }
}

export async function signReceipt(secret: string, payload: ReceiptPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(canonicalJson(payload)));
  const signature = await hmac(secret, encodedPayload);
  return `${RECEIPT_PREFIX}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

export function verifyReceipt(
  secret: string,
  receipt: string,
  expectedType: "dry_run",
  now?: Date,
): Promise<DryRunReceiptPayload>;
export function verifyReceipt(
  secret: string,
  receipt: string,
  expectedType: "approval",
  now?: Date,
): Promise<ApprovalReceiptPayload>;
export async function verifyReceipt(
  secret: string,
  receipt: string,
  expectedType: ReceiptPayload["receipt_type"],
  now = new Date(),
): Promise<ReceiptPayload> {
  const pieces = receipt.split(".");
  if (pieces.length !== 3 || pieces[0] !== RECEIPT_PREFIX) {
    throw new NewoControlError(400, "newo_control_receipt_invalid");
  }
  let signature: Uint8Array;
  let payloadText: string;
  try {
    signature = base64UrlDecode(pieces[2]);
    payloadText = new TextDecoder().decode(base64UrlDecode(pieces[1]));
  } catch {
    throw new NewoControlError(400, "newo_control_receipt_invalid");
  }
  const key = await hmacKey(secret, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(pieces[1]))) {
    throw new NewoControlError(401, "newo_control_receipt_signature_invalid");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch {
    throw new NewoControlError(400, "newo_control_receipt_invalid");
  }
  const payload = parseReceiptPayload(raw);
  if (payload.receipt_type !== expectedType) {
    throw new NewoControlError(400, "newo_control_receipt_type_invalid");
  }
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new NewoControlError(409, "newo_control_receipt_expired");
  }
  return payload;
}

function parseReceiptPayload(value: unknown): ReceiptPayload {
  const raw = plainObject(value, "receipt");
  const receiptType = raw.receipt_type;
  const common = [
    "receipt_type", "schema_version", "action_id", "operation", "args_hash", "issued_at", "expires_at",
  ];
  if (receiptType === "dry_run") {
    exactKeys(raw, [...common, "requested_by"], [], "receipt");
    return {
      receipt_type: "dry_run",
      schema_version: schemaVersion(raw.schema_version),
      action_id: uuid(raw.action_id, "action_id"),
      operation: controlOperation(raw.operation),
      args_hash: hexHash(raw.args_hash, "args_hash"),
      requested_by: boundedText(raw.requested_by, 3, 128, "requested_by"),
      issued_at: isoDate(raw.issued_at, "issued_at"),
      expires_at: isoDate(raw.expires_at, "expires_at"),
    };
  }
  if (receiptType === "approval") {
    exactKeys(raw, [...common, "dry_run_receipt_hash", "approved_by", "reason"], [], "receipt");
    return {
      receipt_type: "approval",
      schema_version: schemaVersion(raw.schema_version),
      action_id: uuid(raw.action_id, "action_id"),
      operation: controlOperation(raw.operation),
      args_hash: hexHash(raw.args_hash, "args_hash"),
      dry_run_receipt_hash: hexHash(raw.dry_run_receipt_hash, "dry_run_receipt_hash"),
      approved_by: boundedText(raw.approved_by, 3, 128, "approved_by"),
      reason: boundedText(raw.reason, 10, 500, "reason"),
      issued_at: isoDate(raw.issued_at, "issued_at"),
      expires_at: isoDate(raw.expires_at, "expires_at"),
    };
  }
  throw new NewoControlError(400, "newo_control_receipt_type_invalid");
}

async function executeProviderMutation(env: Env, action: NewoControlAction): Promise<NewoJson> {
  const client = new NewoApiClient(newoClientConfigFromEnv(env));
  switch (action.operation) {
    case "auth.token.revoke": return await client.revokeToken();
    case "agent_actor.create": return await client.createAgentActor(action.args);
    case "user_actor.create": return await client.createUserActor(action.args);
    case "user_actor.get_or_create": return await client.getOrCreateUserActor(action.args);
    case "user_actor.update": return await client.updateUserActor(action.args.actor_id, action.args.input);
    case "user_actor.delete": return await client.deleteUserActor(action.args.actor_id);
    case "chat.user.send": return await client.sendUserMessage(action.args.user_actor_id, action.args.input);
    case "conversation.agent_message.send": return await client.sendAgentMessage(action.args);
    case "session.update": return await client.updateSession(action.args.session_id, action.args.input);
    case "webhook.outgoing.create": return await client.createOutgoingWebhook(action.args);
    case "webhook.outgoing.update":
      return await client.updateOutgoingWebhook(action.args.webhook_id, action.args.input);
    case "webhook.outgoing.delete": return await client.deleteOutgoingWebhook(action.args.webhook_id);
    case "webhook.incoming.create": return await client.createIncomingWebhook(action.args);
    case "webhook.incoming.update":
      return await client.updateIncomingWebhook(action.args.webhook_id, action.args.input);
    case "webhook.incoming.delete": return await client.deleteIncomingWebhook(action.args.webhook_id);
  }
}

/**
 * Newo control already has a signed human approval and a durable control receipt.
 * The provider call is nevertheless one external effect, so the runtime binds
 * that receipt to the universal ledger before dispatch.
 */
async function executeNewoMutationThroughRuntime(
  env: Env,
  action: NewoControlAction,
  approvedBy: string,
  approvalReceiptHash: string,
  approvalExpiresAt: string,
  now: Date,
): Promise<NewoJson> {
  const runtime = env as Env & {
    APP_TENANT_ID?: string;
  };
  assertEffectLedgerReady(env);
  const tenantId = String(runtime.APP_TENANT_ID ?? "ironwrap");
  const args = action.args;
  const argsHash = await actionHash(action);
  const idempotencyKey = `newo:${action.operation}:${argsHash}`;
  const approvalExpiryMs = Date.parse(approvalExpiresAt);
  const deadlineAt = new Date(Math.min(
    now.getTime() + 5 * 60_000,
    Number.isFinite(approvalExpiryMs) ? approvalExpiryMs : now.getTime() + 5 * 60_000,
  )).toISOString();
  const authority = {
    permitRef: `newo:approval:${approvalReceiptHash}`,
    policyRef: `newo.control:${action.operation}`,
    policyVersion: CONTROL_SCHEMA_VERSION,
    tenantId,
    actorType: "owner" as const,
    actorId: approvedBy,
    expiresAt: deadlineAt,
    allowedActions: [action.operation],
    maxAttempts: 1,
  };
  const client = new NewoApiClient(newoClientConfigFromEnv(env));
  const result = await runExternalEffect(env as never, {
    tenantId,
    actor: { type: "owner", id: approvedBy },
    taskId: `newo-control:${action.operation}`,
    authority,
    aggregate: { type: "newo_control_action", id: idempotencyKey, version: 0 },
    intentId: idempotencyKey,
    action: action.operation,
    request: { operation: action.operation, args },
    requestHash: argsHash,
    provider: "newo",
    idempotencyKey,
    deadlineAt,
    expectedReadback: {},
    retryLimit: 0,
    compensationPlan: {},
    correlationId: idempotencyKey,
  }, {
    async dispatch() {
      const value = await executeProviderMutation(env, action);
      return {
        outcome: "accepted" as const,
        value,
        providerExternalId: providerExternalId(action, value),
        providerResponse: value,
      };
    },
    async readback({ providerExternalId }) {
      return await readbackNewoMutation(client, action, providerExternalId);
    },
    async replay({ effect }) {
      const readback = await readbackNewoMutation(client, action, effect.provider_external_id);
      if (readback.status !== "match" || readback.observed === undefined) {
        throw new NewoControlError(502, readback.detailCode ?? "newo_replay_readback_failed");
      }
      return readback.observed as NewoJson;
    },
  }, now);
  if (result.effect.state === "unknown") {
    throw new EffectRuntimeError("effect_unknown_requires_reconciliation");
  }
  if (result.effect.state !== "succeeded" || result.value === undefined) {
    throw new NewoControlError(502, result.effect.result_code ?? "newo_effect_not_succeeded");
  }
  return result.value;
}

function providerExternalId(action: NewoControlAction, value: NewoJson): string | null {
  if (action.operation === "user_actor.update" || action.operation === "user_actor.delete") return action.args.actor_id;
  if (action.operation === "session.update") return action.args.session_id;
  if (action.operation === "webhook.outgoing.create" || action.operation === "webhook.incoming.create") {
    return action.args.idn;
  }
  if (action.operation === "webhook.outgoing.update" || action.operation === "webhook.outgoing.delete" ||
      action.operation === "webhook.incoming.update" || action.operation === "webhook.incoming.delete") {
    return action.args.webhook_id;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["id", "idn", "actor_id", "user_actor_id", "agent_actor_id", "webhook_id", "session_id"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate) return candidate;
    }
  }
  return null;
}

async function readbackNewoMutation(
  client: NewoApiClient,
  action: NewoControlAction,
  providerExternalId: string | null,
): Promise<{
  status: "match" | "conflict" | "unavailable" | "not_found";
  observed?: unknown;
  detailCode?: string;
}> {
  try {
    if (action.operation === "agent_actor.create" && providerExternalId) {
      const observed = await client.getAgentActor(providerExternalId);
      return { status: "match", observed };
    }
    if ((action.operation === "user_actor.create" || action.operation === "user_actor.get_or_create" ||
      action.operation === "user_actor.update") && providerExternalId) {
      const observed = await client.getUserActor(providerExternalId);
      return { status: "match", observed };
    }
    if (action.operation === "session.update" && providerExternalId) {
      const observed = await client.getSession(providerExternalId);
      const row = observed && typeof observed === "object" && !Array.isArray(observed)
        ? observed as Record<string, unknown>
        : {};
      const observedId = row.id ?? row.session_id;
      const matches = observedId === providerExternalId &&
        Object.entries(action.args.input).every(([key, value]) => row[key] === value);
      return matches
        ? { status: "match", observed: row }
        : { status: "conflict", observed: row, detailCode: "newo_session_readback_conflict" };
    }
    if (action.operation === "webhook.outgoing.create" || action.operation === "webhook.outgoing.update") {
      const rows = await client.listOutgoingWebhooks();
      return webhookReadback(rows, providerExternalId);
    }
    if (action.operation === "webhook.incoming.create" || action.operation === "webhook.incoming.update") {
      const rows = await client.listIncomingWebhooks();
      return webhookReadback(rows, providerExternalId);
    }
    if (action.operation === "user_actor.delete" && providerExternalId) {
      try {
        await client.getUserActor(providerExternalId);
        return { status: "conflict", observed: { deleted: false }, detailCode: "newo_delete_readback_present" };
      } catch (error) {
        return /newo_api_http_404/.test(String(error))
          ? { status: "match", observed: { deleted: true } }
          : { status: "unavailable", detailCode: "newo_delete_readback_unavailable" };
      }
    }
  } catch {
    return { status: "unavailable", detailCode: "newo_readback_unavailable" };
  }
  return { status: "unavailable", detailCode: "newo_readback_not_supported" };
}

function webhookReadback(
  rows: NewoJson,
  providerExternalId: string | null,
): { status: "match" | "conflict" | "unavailable" | "not_found"; observed?: unknown; detailCode?: string } {
  if (!providerExternalId || !Array.isArray(rows)) return { status: "unavailable", detailCode: "newo_webhook_id_missing" };
  const matches = rows.filter((value) => value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).some((candidate) => candidate === providerExternalId));
  if (matches.length === 1) return { status: "match", observed: matches[0] };
  if (matches.length === 0) return { status: "not_found", detailCode: "newo_webhook_readback_not_found" };
  return { status: "conflict", observed: matches, detailCode: "newo_webhook_readback_ambiguous" };
}

function enforceExecutionPolicy(env: Env, action: NewoControlAction): void {
  const runtime = env as unknown as Record<string, string | undefined>;
  if (String(runtime.NEWO_ENABLED) !== "true") throw new NewoControlError(503, "newo_disabled");
  if (String(runtime.NEWO_CONTROL_WRITE_ENABLED) !== "true") {
    throw new NewoControlError(403, "newo_control_write_disabled");
  }
  if (isCustomerSend(action.operation) && String(runtime.NEWO_OUTBOUND_ENABLED) !== "true") {
    throw new NewoControlError(403, "newo_outbound_disabled");
  }
  if (action.operation === "webhook.outgoing.delete" || action.operation === "webhook.incoming.delete") {
    const protectedIds = new Set([
      runtime.NEWO_REPORT_WEBHOOK_ID,
      runtime.NEWO_HANDOFF_WEBHOOK_ID,
      ...(runtime.NEWO_PROTECTED_WEBHOOK_IDS ?? "").split(","),
    ].map((value) => value?.trim()).filter((value): value is string => Boolean(value)));
    if (protectedIds.has(action.args.webhook_id)) {
      throw new NewoControlError(409, "newo_production_webhook_delete_forbidden");
    }
  }
}

function previewPolicy(action: NewoControlAction): {
  customer_send: boolean;
  destructive: boolean;
  protected_resource_check: boolean;
  summary: string;
} {
  return {
    customer_send: isCustomerSend(action.operation),
    destructive: action.operation.endsWith(".delete") || action.operation === "auth.token.revoke",
    protected_resource_check: action.operation.endsWith("webhook.outgoing.delete") ||
      action.operation.endsWith("webhook.incoming.delete"),
    summary: `Governed Newo operation: ${action.operation}`,
  };
}

function isCustomerSend(operation: NewoControlOperation): boolean {
  return operation === "chat.user.send" || operation === "conversation.agent_message.send";
}

async function actionHash(action: NewoControlAction): Promise<string> {
  return await sha256Hex(canonicalJson({ operation: action.operation, args: action.args }));
}

function parseAgentActor(args: Record<string, unknown>): NewoAgentActorInput {
  exactKeys(args, ["persona_id", "external_id", "integration_idn", "connector_idn"], [], "args");
  return {
    persona_id: boundedText(args.persona_id, 1, 128, "persona_id"),
    external_id: boundedText(args.external_id, 1, 256, "external_id"),
    integration_idn: boundedText(args.integration_idn, 1, 128, "integration_idn"),
    connector_idn: boundedText(args.connector_idn, 1, 128, "connector_idn"),
  };
}

function parseUserActor(args: Record<string, unknown>): NewoUserActorInput {
  exactKeys(args, ["name", "external_id", "integration_idn", "connector_idn"], ["time_zone_identifier"], "args");
  return {
    name: boundedText(args.name, 1, 256, "name"),
    external_id: boundedText(args.external_id, 1, 256, "external_id"),
    integration_idn: boundedText(args.integration_idn, 1, 128, "integration_idn"),
    connector_idn: boundedText(args.connector_idn, 1, 128, "connector_idn"),
    ...(args.time_zone_identifier === undefined ? {} : {
      time_zone_identifier: boundedText(args.time_zone_identifier, 1, 128, "time_zone_identifier"),
    }),
  };
}

function parseUserActorUpdate(value: unknown): NewoUserActorUpdate {
  const input = plainObject(value, "input");
  exactKeys(input, [], ["name", "time_zone_identifier"], "input");
  if (Object.keys(input).length === 0) throw new NewoControlError(400, "newo_control_empty_update");
  return {
    ...(input.name === undefined ? {} : { name: boundedText(input.name, 1, 256, "name") }),
    ...(input.time_zone_identifier === undefined ? {} : {
      time_zone_identifier: boundedText(input.time_zone_identifier, 1, 128, "time_zone_identifier"),
    }),
  };
}

function parseChatMessage(value: unknown): NewoChatMessageInput {
  const input = plainObject(value, "input");
  exactKeys(input, ["text"], ["command_act_id", "external_event_id", "arguments", "uninterruptible"], "input");
  let args: Array<{ name: string; value: string }> | undefined;
  if (input.arguments !== undefined) {
    if (!Array.isArray(input.arguments) || input.arguments.length > 25) {
      throw new NewoControlError(400, "newo_control_arguments_invalid");
    }
    args = input.arguments.map((item, index) => {
      const entry = plainObject(item, `arguments[${index}]`);
      exactKeys(entry, ["name", "value"], [], `arguments[${index}]`);
      return {
        name: boundedText(entry.name, 1, 128, "argument.name"),
        value: boundedText(entry.value, 0, 4_000, "argument.value"),
      };
    });
  }
  return {
    text: boundedText(input.text, 1, 10_000, "text"),
    ...(input.command_act_id === undefined ? {} : { command_act_id: providerId(input.command_act_id, "command_act_id") }),
    ...(input.external_event_id === undefined ? {} : {
      external_event_id: boundedText(input.external_event_id, 1, 256, "external_event_id"),
    }),
    ...(args === undefined ? {} : { arguments: args }),
    ...(input.uninterruptible === undefined ? {} : {
      uninterruptible: booleanValue(input.uninterruptible, "uninterruptible"),
    }),
  };
}

function parseAgentMessage(args: Record<string, unknown>): NewoAgentMessageInput {
  exactKeys(args, ["agent_actor_id", "user_actor_ids", "text"], ["external_event_id"], "args");
  if (!Array.isArray(args.user_actor_ids) || args.user_actor_ids.length < 1 || args.user_actor_ids.length > 25) {
    throw new NewoControlError(400, "newo_control_user_actor_ids_invalid");
  }
  return {
    agent_actor_id: providerId(args.agent_actor_id, "agent_actor_id"),
    user_actor_ids: args.user_actor_ids.map((value) => providerId(value, "user_actor_id")),
    text: boundedText(args.text, 1, 10_000, "text"),
    ...(args.external_event_id === undefined ? {} : {
      external_event_id: boundedText(args.external_event_id, 1, 256, "external_event_id"),
    }),
  };
}

function parseSessionUpdate(value: unknown): NewoSessionUpdate {
  const input = plainObject(value, "input");
  const fields = [
    "session_type", "is_test", "is_success", "is_lead", "comment", "conversation_penalty",
    "need_follow_up", "is_archived", "is_sales_opportunity",
  ];
  exactKeys(input, [], fields, "input");
  if (Object.keys(input).length === 0) throw new NewoControlError(400, "newo_control_empty_update");
  const out: NewoSessionUpdate = {};
  if (input.session_type !== undefined) out.session_type = boundedText(input.session_type, 1, 128, "session_type");
  for (const field of ["is_test", "is_lead", "need_follow_up", "is_archived", "is_sales_opportunity"] as const) {
    if (input[field] !== undefined) out[field] = booleanValue(input[field], field);
  }
  if (input.is_success !== undefined) {
    if (input.is_success !== null && typeof input.is_success !== "boolean") {
      throw new NewoControlError(400, "newo_control_is_success_invalid");
    }
    out.is_success = input.is_success as boolean | null;
  }
  if (input.comment !== undefined) out.comment = boundedText(input.comment, 0, 2_000, "comment");
  if (input.conversation_penalty !== undefined) {
    const penalty = Number(input.conversation_penalty);
    if (!Number.isFinite(penalty) || penalty < -100 || penalty > 100) {
      throw new NewoControlError(400, "newo_control_conversation_penalty_invalid");
    }
    out.conversation_penalty = penalty;
  }
  return out;
}

function parseOutgoingWebhook(value: unknown, partial: boolean): Partial<NewoOutgoingWebhookInput> {
  const input = plainObject(value, "input");
  const required = partial ? [] : ["idn", "url", "connector_idn", "command_idns"];
  exactKeys(input, required, partial
    ? ["idn", "description", "url", "connector_idn", "command_idns"]
    : ["description"], "input");
  if (partial && Object.keys(input).length === 0) throw new NewoControlError(400, "newo_control_empty_update");
  return {
    ...(input.idn === undefined ? {} : { idn: boundedText(input.idn, 1, 128, "idn") }),
    ...(input.description === undefined ? {} : { description: boundedText(input.description, 0, 1_000, "description") }),
    ...(input.url === undefined ? {} : { url: httpsUrl(input.url, "url") }),
    ...(input.connector_idn === undefined ? {} : {
      connector_idn: boundedText(input.connector_idn, 1, 128, "connector_idn"),
    }),
    ...(input.command_idns === undefined ? {} : {
      command_idns: nullableStringArray(input.command_idns, 100, "command_idns"),
    }),
  };
}

function parseIncomingWebhook(value: unknown, partial: boolean): Partial<NewoIncomingWebhookInput> {
  const input = plainObject(value, "input");
  const required = partial ? [] : ["idn", "connector_idn", "event_idns"];
  exactKeys(input, required, partial
    ? ["idn", "description", "connector_idn", "event_idns", "allowed_ips"]
    : ["description", "allowed_ips"], "input");
  if (partial && Object.keys(input).length === 0) throw new NewoControlError(400, "newo_control_empty_update");
  return {
    ...(input.idn === undefined ? {} : { idn: boundedText(input.idn, 1, 128, "idn") }),
    ...(input.description === undefined ? {} : { description: boundedText(input.description, 0, 1_000, "description") }),
    ...(input.connector_idn === undefined ? {} : {
      connector_idn: boundedText(input.connector_idn, 1, 128, "connector_idn"),
    }),
    ...(input.event_idns === undefined ? {} : {
      event_idns: nullableStringArray(input.event_idns, 100, "event_idns"),
    }),
    ...(input.allowed_ips === undefined ? {} : {
      allowed_ips: nullableStringArray(input.allowed_ips, 100, "allowed_ips"),
    }),
  };
}

function requireSigningSecret(env: Env): string {
  const secret = String((env as Env & { NEWO_CONTROL_SIGNING_SECRET?: string }).NEWO_CONTROL_SIGNING_SECRET ?? "").trim();
  if (secret.length < 32) throw new NewoControlError(503, "newo_control_signing_secret_missing");
  return secret;
}

function receiptTtlSeconds(env: Env): number {
  const raw = (env as Env & { NEWO_CONTROL_RECEIPT_TTL_SECONDS?: string }).NEWO_CONTROL_RECEIPT_TTL_SECONDS;
  const value = Number(raw ?? DEFAULT_TTL_SECONDS);
  if (!Number.isInteger(value) || value < 60 || value > 3_600) {
    throw new NewoControlError(503, "newo_control_receipt_ttl_invalid");
  }
  return value;
}

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new NewoControlError(500, "newo_control_stored_args_invalid");
  }
}

function boundedStoredResult(result: string, hash: string): string {
  return new TextEncoder().encode(result).byteLength <= MAX_RESULT_BYTES
    ? result
    : canonicalJson({ omitted: true, sha256: hash, reason: "provider_response_exceeds_64_kib" });
}

function safeFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : "newo_control_unknown_error";
  return value.replace(/[\r\n]/g, " ").slice(0, 500);
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function hmacKey(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NewoControlError(400, `newo_control_${field.replace(/[^a-z0-9]+/gi, "_")}_invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new NewoControlError(400, `newo_control_${field.replace(/[^a-z0-9]+/gi, "_")}_unexpected_field`);
  }
  if (required.some((key) => !(key in value))) {
    throw new NewoControlError(400, `newo_control_${field.replace(/[^a-z0-9]+/gi, "_")}_missing_field`);
  }
}

function boundedText(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== "string") throw new NewoControlError(400, `newo_control_${field}_invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new NewoControlError(400, `newo_control_${field}_invalid`);
  }
  return normalized;
}

function providerId(value: unknown, field: string): string {
  const id = boundedText(value, 1, 128, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new NewoControlError(400, `newo_control_${field}_invalid`);
  }
  return id;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new NewoControlError(400, `newo_control_${field}_invalid`);
  return value;
}

function nullableStringArray(value: unknown, max: number, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) {
    throw new NewoControlError(400, `newo_control_${field}_invalid`);
  }
  return value.map((item) => boundedText(item, 1, 256, field));
}

function httpsUrl(value: unknown, field: string): string {
  const raw = boundedText(value, 8, 2_048, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NewoControlError(400, `newo_control_${field}_invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new NewoControlError(400, `newo_control_${field}_invalid`);
  }
  return url.toString();
}

function uuid(value: unknown, field: string): string {
  const text = boundedText(value, 36, 36, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new NewoControlError(400, `newo_control_${field}_invalid`);
  }
  return text;
}

function hexHash(value: unknown, field: string): string {
  const text = boundedText(value, 64, 64, field);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new NewoControlError(400, `newo_control_${field}_invalid`);
  return text;
}

function isoDate(value: unknown, field: string): string {
  const text = boundedText(value, 20, 32, field);
  if (!Number.isFinite(Date.parse(text))) throw new NewoControlError(400, `newo_control_${field}_invalid`);
  return text;
}

function schemaVersion(value: unknown): typeof CONTROL_SCHEMA_VERSION {
  if (value !== CONTROL_SCHEMA_VERSION) throw new NewoControlError(400, "newo_control_schema_version_invalid");
  return CONTROL_SCHEMA_VERSION;
}

function controlOperation(value: unknown): NewoControlOperation {
  if (typeof value !== "string" || !(NEWO_CONTROL_OPERATIONS as readonly string[]).includes(value)) {
    throw new NewoControlError(400, "newo_control_operation_unsupported");
  }
  return value as NewoControlOperation;
}
