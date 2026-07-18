import {
  NewoApiClient,
  newoClientConfigFromEnv,
  type NewoActorListQuery,
  type NewoActsQuery,
  type NewoAnalyticsQuery,
  type NewoHistoryQuery,
  type NewoJson,
  type NewoSessionAggregateQuery,
} from "./newo-client.ts";
import {
  approveNewoControlAction,
  executeApprovedNewoControlAction,
  NewoControlError,
  previewNewoControlAction,
} from "./newo-control.ts";
import { listNewoControlActions } from "./newo-control-store.ts";
import { listRecentNewoSessions, newoOperationalCounts } from "./newo-store.ts";

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

export const NEWO_ADMIN_READ_OPERATIONS = [
  "agent_actors.list",
  "agent_actor.get",
  "user_actors.list",
  "user_actor.get",
  "user_actor.get_external",
  "chat.user.poll",
  "chat.agent.receive",
  "chat.history",
  "conversations.acts.list",
  "conversations.act.get",
  "session.aggregates",
  "webhooks.outgoing.list",
  "webhooks.incoming.list",
  "analytics.logs",
] as const;

export async function handleNewoAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  try {
    if (req.method === "GET" && url.pathname === "/admin/newo/health") {
      return json(await getNewoAdminHealth(env));
    }
    if (req.method === "GET" && url.pathname === "/admin/newo/sessions") {
      const sessions = await listRecentNewoSessions(env, limit(url.searchParams.get("limit"), 50, 100));
      return json({
        sessions: sessions.map(({ structured_json: _structured, raw_key: _raw, payload_hash: _hash, ...session }) =>
          session),
      });
    }
    if (req.method === "GET" && url.pathname === "/admin/newo/control-actions") {
      return json({
        actions: await listNewoControlActions(env, limit(url.searchParams.get("limit"), 50, 100)),
      });
    }
    if (req.method === "POST" && url.pathname === "/admin/newo/read") {
      return json({ result: await executeNewoAdminRead(env, await readJson(req)) });
    }
    if (req.method === "POST" && url.pathname === "/admin/newo/control/preview") {
      return json(await previewNewoControlAction(env, await readJson(req)), 201);
    }
    if (req.method === "POST" && url.pathname === "/admin/newo/control/approve") {
      return json(await approveNewoControlAction(env, await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/admin/newo/control/execute") {
      return json(await executeApprovedNewoControlAction(env, await readJson(req)));
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof NewoControlError) return json({ error: error.code }, error.status);
    const code = error instanceof Error && /^newo_[a-z0-9_:.-]+$/.test(error.message)
      ? error.message
      : "newo_admin_error";
    return json({ error: code }, code.startsWith("newo_api_") ? 502 : 400);
  }
}

export async function getNewoAdminHealth(env: Env): Promise<{
  enabled: boolean;
  api_configured: boolean;
  api_authenticated: boolean;
  production_actor_configured: boolean;
  control_write_enabled: boolean;
  outbound_enabled: boolean;
  booking_mode: string;
  project_id_configured: boolean;
  report_webhook_id_configured: boolean;
  handoff_webhook_id_configured: boolean;
  counts: Awaited<ReturnType<typeof newoOperationalCounts>>;
  error: string | null;
}> {
  const runtime = env as unknown as Record<string, string | undefined>;
  const enabled = runtime.NEWO_ENABLED === "true";
  const apiConfigured = nonEmpty(runtime.NEWO_API_KEY) && nonEmpty(runtime.NEWO_API_BASE_URL);
  let apiAuthenticated = false;
  let error: string | null = null;
  if (enabled && apiConfigured) {
    try {
      await new NewoApiClient(newoClientConfigFromEnv(env)).authenticate();
      apiAuthenticated = true;
    } catch (cause) {
      error = cause instanceof Error && /^newo_[a-z0-9_:.-]+$/.test(cause.message)
        ? cause.message
        : "newo_api_error";
    }
  }
  return {
    enabled,
    api_configured: apiConfigured,
    api_authenticated: apiAuthenticated,
    production_actor_configured: nonEmpty(runtime.NEWO_AGENT_ID),
    control_write_enabled: runtime.NEWO_CONTROL_WRITE_ENABLED === "true",
    outbound_enabled: runtime.NEWO_OUTBOUND_ENABLED === "true",
    booking_mode: runtime.NEWO_BOOKING_MODE ?? "request_only",
    project_id_configured: nonEmpty(runtime.NEWO_PROJECT_ID),
    report_webhook_id_configured: nonEmpty(runtime.NEWO_REPORT_WEBHOOK_ID),
    handoff_webhook_id_configured: nonEmpty(runtime.NEWO_HANDOFF_WEBHOOK_ID),
    counts: await newoOperationalCounts(env),
    error,
  };
}

export async function executeNewoAdminRead(env: Env, value: unknown): Promise<NewoJson> {
  const root = object(value, "body");
  exact(root, ["operation"], ["args"], "body");
  const operation = text(root.operation, 3, 80, "operation");
  const args = object(root.args ?? {}, "args");
  const client = new NewoApiClient(newoClientConfigFromEnv(env));

  switch (operation) {
    case "agent_actors.list":
      return await client.listAgentActors(actorListQuery(args));
    case "agent_actor.get":
      exact(args, ["actor_id"], [], "args");
      return await client.getAgentActor(id(args.actor_id, "actor_id"));
    case "user_actors.list":
      return await client.listUserActors(actorListQuery(args));
    case "user_actor.get":
      exact(args, ["actor_id"], [], "args");
      return await client.getUserActor(id(args.actor_id, "actor_id"));
    case "user_actor.get_external":
      exact(args, ["external_id", "integration_idn", "connector_idn"], [], "args");
      return await client.getUserActorByExternalId({
        external_id: text(args.external_id, 1, 256, "external_id"),
        integration_idn: text(args.integration_idn, 1, 128, "integration_idn"),
        connector_idn: text(args.connector_idn, 1, 128, "connector_idn"),
      });
    case "chat.user.poll":
      exact(args, ["user_actor_id"], ["is_streaming"], "args");
      return await client.pollUserMessages(
        id(args.user_actor_id, "user_actor_id"),
        optionalBoolean(args.is_streaming, false, "is_streaming"),
      );
    case "chat.agent.receive":
      exact(args, ["agent_actor_id"], ["is_streaming"], "args");
      return await client.receiveAgentMessages(
        id(args.agent_actor_id, "agent_actor_id"),
        optionalBoolean(args.is_streaming, false, "is_streaming"),
      );
    case "chat.history":
      return await client.getChatHistory(historyQuery(args));
    case "conversations.acts.list":
      return await client.listActs(actsQuery(args));
    case "conversations.act.get":
      exact(args, ["act_id"], [], "args");
      return await client.getAct(id(args.act_id, "act_id"));
    case "session.aggregates":
      return await client.getSessionAggregates(sessionAggregateQuery(args));
    case "webhooks.outgoing.list":
      exact(args, [], [], "args");
      return await client.listOutgoingWebhooks();
    case "webhooks.incoming.list":
      exact(args, [], [], "args");
      return await client.listIncomingWebhooks();
    case "analytics.logs":
      return await client.getAnalyticsLogs(analyticsQuery(args));
    default:
      throw new NewoControlError(400, "newo_admin_read_operation_unsupported");
  }
}

function actorListQuery(args: Record<string, unknown>): NewoActorListQuery {
  exact(args, ["integration_idn", "connector_idn"], ["limit", "offset"], "args");
  return {
    integration_idn: text(args.integration_idn, 1, 128, "integration_idn"),
    connector_idn: text(args.connector_idn, 1, 128, "connector_idn"),
    ...(args.limit === undefined ? {} : { limit: integer(args.limit, 1, 100, "limit") }),
    ...(args.offset === undefined ? {} : { offset: integer(args.offset, 0, 10_000, "offset") }),
  };
}

function historyQuery(args: Record<string, unknown>): NewoHistoryQuery {
  exact(args, [], ["user_actor_id", "agent_actor_id", "limit", "offset"], "args");
  if (args.user_actor_id === undefined && args.agent_actor_id === undefined) {
    throw new NewoControlError(400, "newo_admin_history_actor_required");
  }
  return {
    ...(args.user_actor_id === undefined ? {} : { user_actor_id: id(args.user_actor_id, "user_actor_id") }),
    ...(args.agent_actor_id === undefined ? {} : { agent_actor_id: id(args.agent_actor_id, "agent_actor_id") }),
    limit: args.limit === undefined ? 50 : integer(args.limit, 1, 100, "limit"),
    offset: args.offset === undefined ? 0 : integer(args.offset, 0, 10_000, "offset"),
  };
}

function actsQuery(args: Record<string, unknown>): NewoActsQuery {
  const fields = [
    "query", "user_person_id", "user_actor_ids", "agent_person_id", "agent_actor_id",
    "flow_idn", "skill_idn", "reference_idns", "limit", "offset",
  ];
  exact(args, [], fields, "args");
  return {
    ...(args.query === undefined ? {} : { query: text(args.query, 1, 512, "query") }),
    ...(args.user_person_id === undefined ? {} : { user_person_id: id(args.user_person_id, "user_person_id") }),
    ...(args.user_actor_ids === undefined ? {} : { user_actor_ids: csvIds(args.user_actor_ids, "user_actor_ids") }),
    ...(args.agent_person_id === undefined ? {} : { agent_person_id: id(args.agent_person_id, "agent_person_id") }),
    ...(args.agent_actor_id === undefined ? {} : { agent_actor_id: id(args.agent_actor_id, "agent_actor_id") }),
    ...(args.flow_idn === undefined ? {} : { flow_idn: text(args.flow_idn, 1, 128, "flow_idn") }),
    ...(args.skill_idn === undefined ? {} : { skill_idn: stringArray(args.skill_idn, 50, "skill_idn") }),
    ...(args.reference_idns === undefined ? {} : {
      reference_idns: stringArray(args.reference_idns, 50, "reference_idns"),
    }),
    limit: args.limit === undefined ? 50 : integer(args.limit, 1, 100, "limit"),
    offset: args.offset === undefined ? 0 : integer(args.offset, 0, 10_000, "offset"),
  };
}

function sessionAggregateQuery(args: Record<string, unknown>): NewoSessionAggregateQuery {
  exact(args, ["from_datetime", "to_datetime"], ["external_customer_ids"], "args");
  const from = date(args.from_datetime, "from_datetime");
  const to = date(args.to_datetime, "to_datetime");
  if (Date.parse(from) > Date.parse(to) || Date.parse(to) - Date.parse(from) > 366 * 86_400_000) {
    throw new NewoControlError(400, "newo_admin_session_range_invalid");
  }
  return {
    from_datetime: from,
    to_datetime: to,
    ...(args.external_customer_ids === undefined ? {} : {
      external_customer_ids: stringArray(args.external_customer_ids, 100, "external_customer_ids"),
    }),
  };
}

function analyticsQuery(args: Record<string, unknown>): NewoAnalyticsQuery {
  const fields = [
    "page", "per", "from_datetime", "to_datetime", "levels", "log_types", "external_event_id",
    "user_actor_ids", "agent_actor_ids", "connector_idns", "flow_idns", "skill_idns",
  ];
  exact(args, ["page", "per"], fields.filter((field) => field !== "page" && field !== "per"), "args");
  return {
    page: integer(args.page, 1, 10_000, "page"),
    per: integer(args.per, 1, 100, "per"),
    ...(args.from_datetime === undefined ? {} : { from_datetime: date(args.from_datetime, "from_datetime") }),
    ...(args.to_datetime === undefined ? {} : { to_datetime: date(args.to_datetime, "to_datetime") }),
    ...(args.levels === undefined ? {} : { levels: stringArray(args.levels, 20, "levels") }),
    ...(args.log_types === undefined ? {} : { log_types: stringArray(args.log_types, 20, "log_types") }),
    ...(args.external_event_id === undefined ? {} : {
      external_event_id: text(args.external_event_id, 1, 256, "external_event_id"),
    }),
    ...(args.user_actor_ids === undefined ? {} : {
      user_actor_ids: stringArray(args.user_actor_ids, 100, "user_actor_ids"),
    }),
    ...(args.agent_actor_ids === undefined ? {} : {
      agent_actor_ids: stringArray(args.agent_actor_ids, 100, "agent_actor_ids"),
    }),
    ...(args.connector_idns === undefined ? {} : {
      connector_idns: stringArray(args.connector_idns, 100, "connector_idns"),
    }),
    ...(args.flow_idns === undefined ? {} : { flow_idns: stringArray(args.flow_idns, 100, "flow_idns") }),
    ...(args.skill_idns === undefined ? {} : { skill_idns: stringArray(args.skill_idns, 100, "skill_idns") }),
  };
}

async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new NewoControlError(415, "newo_admin_content_type_invalid");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_ADMIN_BODY_BYTES) throw new NewoControlError(413, "newo_admin_payload_too_large");
  const textBody = await req.text();
  if (new TextEncoder().encode(textBody).byteLength > MAX_ADMIN_BODY_BYTES) {
    throw new NewoControlError(413, "newo_admin_payload_too_large");
  }
  try {
    return JSON.parse(textBody);
  } catch {
    throw new NewoControlError(400, "newo_admin_json_invalid");
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: string[], optional: string[], field: string): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new NewoControlError(400, `newo_admin_${field}_unexpected_field`);
  }
  if (required.some((key) => !(key in value))) {
    throw new NewoControlError(400, `newo_admin_${field}_missing_field`);
  }
}

function text(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== "string") throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  }
  return normalized;
}

function id(value: unknown, field: string): string {
  const result = text(value, 1, 128, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(result)) {
    throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  }
  return result;
}

function integer(value: unknown, min: number, max: number, field: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  }
  return result;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  return value;
}

function stringArray(value: unknown, max: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  }
  return value.map((item) => text(item, 1, 256, field));
}

function csvIds(value: unknown, field: string): string {
  return stringArray(value, 50, field).map((item) => id(item, field)).join(",");
}

function date(value: unknown, field: string): string {
  const result = text(value, 20, 32, field);
  if (!Number.isFinite(Date.parse(result))) throw new NewoControlError(400, `newo_admin_${field}_invalid`);
  return result;
}

function limit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  return integer(raw, 1, max, "limit");
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
