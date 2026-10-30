export type NewoJson = null | boolean | number | string | NewoJson[] | { [key: string]: NewoJson };
export interface NewoClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface NewoActorListQuery {
  integration_idn: string;
  connector_idn: string;
  limit?: number;
  offset?: number;
}

export interface NewoAgentActorInput {
  persona_id: string;
  external_id: string;
  integration_idn: string;
  connector_idn: string;
}

export interface NewoUserActorInput {
  name: string;
  external_id: string;
  integration_idn: string;
  connector_idn: string;
  time_zone_identifier?: string;
}

export interface NewoUserActorUpdate {
  name?: string;
  time_zone_identifier?: string;
}

export interface NewoChatMessageInput {
  text: string;
  command_act_id?: string;
  external_event_id?: string;
  arguments?: Array<{ name: string; value: string }>;
  uninterruptible?: boolean;
}

export interface NewoHistoryQuery {
  user_actor_id?: string;
  agent_actor_id?: string;
  limit?: number;
  offset?: number;
}

export interface NewoActsQuery {
  query?: string;
  user_person_id?: string;
  user_actor_ids?: string;
  agent_person_id?: string;
  agent_actor_id?: string;
  flow_idn?: string;
  skill_idn?: string[];
  reference_idns?: string[];
  limit?: number;
  offset?: number;
}

export interface NewoAgentMessageInput {
  agent_actor_id: string;
  user_actor_ids: string[];
  text: string;
  external_event_id?: string;
}

export interface NewoSessionUpdate {
  session_type?: string;
  is_test?: boolean;
  is_success?: boolean | null;
  is_lead?: boolean;
  comment?: string;
  conversation_penalty?: number;
  need_follow_up?: boolean;
  is_archived?: boolean;
  is_sales_opportunity?: boolean;
}

export interface NewoSessionAggregateQuery {
  from_datetime: string;
  to_datetime: string;
  external_customer_ids?: string[];
}

export interface NewoOutgoingWebhookInput {
  idn: string;
  description?: string;
  url: string;
  connector_idn: string;
  command_idns: string[] | null;
}

export interface NewoIncomingWebhookInput {
  idn: string;
  description?: string;
  connector_idn: string;
  event_idns: string[] | null;
  allowed_ips?: string[] | null;
}

export interface NewoAnalyticsQuery {
  page: number;
  per: number;
  from_datetime?: string;
  to_datetime?: string;
  levels?: string[];
  log_types?: string[];
  external_event_id?: string;
  user_actor_ids?: string[];
  agent_actor_ids?: string[];
  connector_idns?: string[];
  flow_idns?: string[];
  skill_idns?: string[];
}

interface IsolateTokenState {
  cacheKey: string;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

let isolateTokens: IsolateTokenState | null = null;
let tokenExchange: Promise<IsolateTokenState> | null = null;

export const NEWO_DOCUMENTED_OPERATIONS = [
  "obtainAccessToken", "refreshAccessToken", "revokeToken",
  "listAgentActors", "createAgentActor", "getAgentActor",
  "listUserActors", "createUserActor", "getOrCreateUserActor", "getUserActor",
  "getUserActorByExternalId", "updateUserActor", "deleteUserActor",
  "sendUserMessage", "pollUserMessages", "receiveAgentMessages", "getChatHistory",
  "listActs", "getAct", "sendAgentMessage",
  "updateSession", "getSessionAggregates",
  "listOutgoingWebhooks", "createOutgoingWebhook", "updateOutgoingWebhook", "deleteOutgoingWebhook",
  "listIncomingWebhooks", "createIncomingWebhook", "updateIncomingWebhook", "deleteIncomingWebhook",
  "getAnalyticsLogs",
] as const;

export function newoClientConfigFromEnv(env: Env): NewoClientConfig {
  const runtime = env as Env & {
    NEWO_API_BASE_URL?: string;
    NEWO_API_KEY?: string;
    NEWO_API_TIMEOUT_MS?: string;
  };
  const baseUrl = normalizeBaseUrl(String(runtime.NEWO_API_BASE_URL ?? ""));
  const apiKey = String(runtime.NEWO_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("newo_api_key_missing");
  const timeoutMs = boundedInteger(runtime.NEWO_API_TIMEOUT_MS, 10_000, 1_000, 60_000);
  return { baseUrl, apiKey, timeoutMs };
}

export class NewoApiClient {
  private readonly config: NewoClientConfig;

  constructor(config: NewoClientConfig) {
    this.config = config;
  }

  async authenticate(): Promise<{ expires_at: string }> {
    const token = await this.getToken(true);
    return { expires_at: new Date(token.expiresAtMs).toISOString() };
  }

  async revokeToken(): Promise<NewoJson> {
    const token = await this.getToken();
    const response = await this.requestWithToken(
      "POST",
      "/api/v1/auth/token/revoke",
      token.accessToken,
      { refresh_token: token.refreshToken },
    );
    if (isolateTokens?.cacheKey === this.cacheKey()) isolateTokens = null;
    return response.body;
  }

  async listAgentActors(query: NewoActorListQuery): Promise<NewoJson> {
    return await this.get("/api/v1/actors/agent", query);
  }

  async createAgentActor(input: NewoAgentActorInput): Promise<NewoJson> {
    return await this.post("/api/v1/actors/agent", input, new Set([201]));
  }

  async getAgentActor(actorId: string): Promise<NewoJson> {
    return await this.get(`/api/v1/actors/agent/${safeId(actorId)}`);
  }

  async listUserActors(query: NewoActorListQuery): Promise<NewoJson> {
    return await this.get("/api/v1/actors/user", query);
  }

  async createUserActor(input: NewoUserActorInput): Promise<NewoJson> {
    return await this.post("/api/v1/actors/user", input, new Set([201]));
  }

  async getOrCreateUserActor(input: NewoUserActorInput): Promise<NewoJson> {
    return await this.post("/api/v1/actors/user/get-or-create", input, new Set([200, 201]));
  }

  async getUserActor(actorId: string): Promise<NewoJson> {
    return await this.get(`/api/v1/actors/user/${safeId(actorId)}`);
  }

  async getUserActorByExternalId(query: {
    external_id: string;
    integration_idn: string;
    connector_idn: string;
  }): Promise<NewoJson> {
    return await this.get("/api/v1/actors/user/external", query);
  }

  async updateUserActor(actorId: string, input: NewoUserActorUpdate): Promise<NewoJson> {
    return await this.patch(`/api/v1/actors/user/${safeId(actorId)}`, input);
  }

  async deleteUserActor(actorId: string): Promise<NewoJson> {
    return await this.delete(`/api/v1/actors/user/${safeId(actorId)}`);
  }

  async sendUserMessage(userActorId: string, input: NewoChatMessageInput): Promise<NewoJson> {
    return await this.post(`/api/v1/chat/user/${safeId(userActorId)}`, input);
  }

  async pollUserMessages(userActorId: string, isStreaming = false): Promise<NewoJson> {
    return await this.get(`/api/v1/chat/user/${safeId(userActorId)}`, { is_streaming: isStreaming });
  }

  async receiveAgentMessages(agentActorId: string, isStreaming = false): Promise<NewoJson> {
    return await this.get(`/api/v1/chat/agent/${safeId(agentActorId)}`, { is_streaming: isStreaming });
  }

  async getChatHistory(query: NewoHistoryQuery): Promise<NewoJson> {
    return await this.get("/api/v1/chat/history", query);
  }

  async listActs(query: NewoActsQuery): Promise<NewoJson> {
    return await this.get("/api/v1/conversations/acts", query);
  }

  async getAct(actId: string): Promise<NewoJson> {
    return await this.get(`/api/v1/conversations/acts/${safeId(actId)}`);
  }

  async sendAgentMessage(input: NewoAgentMessageInput): Promise<NewoJson> {
    return await this.post("/api/v1/conversations/agent-message", input);
  }

  async updateSession(sessionId: string, input: NewoSessionUpdate): Promise<NewoJson> {
    return await this.patch(`/api/v1/sessions/${safeId(sessionId)}`, input);
  }

  async getSession(sessionId: string): Promise<NewoJson> {
    return await this.get(`/api/v1/sessions/${safeId(sessionId)}`);
  }

  async getSessionAggregates(query: NewoSessionAggregateQuery): Promise<NewoJson> {
    return await this.get("/api/v1/bff/sessions/info/multiple", query);
  }

  async listOutgoingWebhooks(): Promise<NewoJson> {
    return await this.get("/api/v1/webhooks");
  }

  async createOutgoingWebhook(input: NewoOutgoingWebhookInput): Promise<NewoJson> {
    return await this.post("/api/v1/webhooks", input, new Set([201]));
  }

  async updateOutgoingWebhook(webhookId: string, input: Partial<NewoOutgoingWebhookInput>): Promise<NewoJson> {
    return await this.patch(`/api/v1/webhooks/${safeId(webhookId)}`, input);
  }

  async deleteOutgoingWebhook(webhookId: string): Promise<NewoJson> {
    return await this.delete(`/api/v1/webhooks/${safeId(webhookId)}`, new Set([204]));
  }

  async listIncomingWebhooks(): Promise<NewoJson> {
    return await this.get("/api/v1/webhooks/incoming");
  }

  async createIncomingWebhook(input: NewoIncomingWebhookInput): Promise<NewoJson> {
    return await this.post("/api/v1/webhooks/incoming", input, new Set([201]));
  }

  async updateIncomingWebhook(webhookId: string, input: Partial<NewoIncomingWebhookInput>): Promise<NewoJson> {
    return await this.patch(`/api/v1/webhooks/incoming/${safeId(webhookId)}`, input);
  }

  async deleteIncomingWebhook(webhookId: string): Promise<NewoJson> {
    return await this.delete(`/api/v1/webhooks/incoming/${safeId(webhookId)}`, new Set([204]));
  }

  async getAnalyticsLogs(query: NewoAnalyticsQuery): Promise<NewoJson> {
    return await this.get("/api/v1/analytics/logs", query);
  }

  private async get(path: string, query?: object): Promise<NewoJson> {
    return await this.authorizedRequest("GET", path + queryString(query));
  }

  private async post(path: string, body: object, statuses = new Set([200])): Promise<NewoJson> {
    return await this.authorizedRequest("POST", path, body, statuses);
  }

  private async patch(path: string, body: object): Promise<NewoJson> {
    return await this.authorizedRequest("PATCH", path, body);
  }

  private async delete(path: string, statuses = new Set([200])): Promise<NewoJson> {
    return await this.authorizedRequest("DELETE", path, undefined, statuses);
  }

  private async authorizedRequest(
    method: string,
    path: string,
    body?: object,
    statuses = new Set([200]),
  ): Promise<NewoJson> {
    let token = await this.getToken();
    let response = await this.requestWithToken(method, path, token.accessToken, body, statuses, true);
    if (response.status !== 401) return response.body;
    token = await this.getToken(true);
    response = await this.requestWithToken(method, path, token.accessToken, body, statuses);
    return response.body;
  }

  private async getToken(forceRefresh = false): Promise<IsolateTokenState> {
    const cacheKey = this.cacheKey();
    const current = isolateTokens?.cacheKey === cacheKey ? isolateTokens : null;
    if (!forceRefresh && current && current.expiresAtMs - 30_000 > Date.now()) return current;
    if (tokenExchange) return await tokenExchange;
    tokenExchange = (async () => {
      if (current?.refreshToken) {
        try {
          return await this.refresh(current.refreshToken);
        } catch {
          isolateTokens = null;
        }
      }
      return await this.exchangeApiKey();
    })();
    try {
      isolateTokens = await tokenExchange;
      return isolateTokens;
    } finally {
      tokenExchange = null;
    }
  }

  private async exchangeApiKey(): Promise<IsolateTokenState> {
    const response = await rawRequest(this.config, "POST", "/api/v1/auth/api-key/token", undefined, {
      "x-api-key": this.config.apiKey,
    }, new Set([200]));
    return tokenState(response.body, this.cacheKey());
  }

  private async refresh(refreshToken: string): Promise<IsolateTokenState> {
    const response = await rawRequest(
      this.config,
      "POST",
      "/api/v1/auth/token/refresh",
      { refresh_token: refreshToken },
      {},
      new Set([200]),
    );
    return tokenState(response.body, this.cacheKey());
  }

  private async requestWithToken(
    method: string,
    path: string,
    accessToken: string,
    body?: object,
    statuses = new Set([200]),
    allowUnauthorized = false,
  ): Promise<{ status: number; body: NewoJson }> {
    return await rawRequest(
      this.config,
      method,
      path,
      body,
      { authorization: `Bearer ${accessToken}` },
      allowUnauthorized ? new Set([...statuses, 401]) : statuses,
    );
  }

  private cacheKey(): string {
    return `${this.config.baseUrl}:${this.config.apiKey.slice(0, 8)}`;
  }
}

async function rawRequest(
  config: NewoClientConfig,
  method: string,
  path: string,
  body: object | undefined,
  headers: Record<string, string>,
  acceptedStatuses: Set<number>,
): Promise<{ status: number; body: NewoJson }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(config.baseUrl + path, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`newo_api_timeout_${config.timeoutMs}ms`);
    throw new Error("newo_api_network_error");
  } finally {
    clearTimeout(timeout);
  }
  const parsed = await boundedJson(response, 1024 * 1024);
  if (!acceptedStatuses.has(response.status)) {
    throw new Error(`newo_api_http_${response.status}:${safeProviderReason(parsed)}`);
  }
  return { status: response.status, body: parsed };
}

async function boundedJson(response: Response, maximumBytes: number): Promise<NewoJson> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximumBytes) throw new Error("newo_api_response_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error("newo_api_response_too_large");
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as NewoJson;
  } catch {
    throw new Error("newo_api_invalid_json");
  }
}

function tokenState(value: NewoJson, cacheKey: string): IsolateTokenState {
  if (!isObject(value) || typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string") {
    throw new Error("newo_auth_invalid_response");
  }
  const expiresIn = Number(value.expires_in ?? 900);
  if (!Number.isFinite(expiresIn) || expiresIn < 30 || expiresIn > 86_400) {
    throw new Error("newo_auth_invalid_expiry");
  }
  return {
    cacheKey,
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
}

function queryString(query?: object): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error("newo_api_invalid_id");
  return encodeURIComponent(value);
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("newo_api_base_url_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("newo_api_base_url_invalid");
  }
  return url.toString().replace(/\/+$/, "");
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("newo_api_timeout_invalid");
  return value;
}

function safeProviderReason(value: NewoJson): string {
  if (isObject(value) && typeof value.code === "number") return `code_${value.code}`;
  return "provider_error";
}

function isObject(value: NewoJson): value is { [key: string]: NewoJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resetNewoTokenCacheForTest(): void {
  isolateTokens = null;
  tokenExchange = null;
}
