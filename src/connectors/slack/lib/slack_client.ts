/**
 * slack_client.ts — Slack Web API client.
 *
 * Thin wrapper over the shared `HttpClient` in `narai-primitives/toolkit`:
 * supplies Bearer auth (bot token by default, user token for `search.*`),
 * the JSON Content-Type, and the Slack-specific endpoint methods. All
 * retry, throttle, timeout, and URL-validation logic comes from the shared
 * client.
 *
 * Slack quirks handled here:
 * - Every response is HTTP 200 with `{ok: true | false, ...}` in the body.
 *   `ok=false` is translated into an `HttpResultErr` whose `code` is the
 *   uppercased Slack error string (e.g. `CHANNEL_NOT_FOUND`).
 * - `search.messages` / `search.files` require a user token; the client
 *   picks the right token per method and surfaces a `CONFIG_ERROR` when
 *   the user token is missing.
 * - `files.getUploadURLExternal` returns an absolute `upload_url`; raw
 *   bytes are POSTed there outside the toolkit's retry loop via
 *   `uploadBytes` (Slack's external upload service rejects PUT).
 */
import {
  HttpClient,
  ConnectorError,
  validateUrl,
  type HttpResult,
  type HttpResultErr,
  type HttpResultOk,
} from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";

const SLACK_API_BASE = "https://slack.com/api";

export interface SlackClientOptions {
  botToken: string;
  userToken?: string;
  defaultTeamId?: string;
  apiBase?: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

// Back-compat type aliases — same shape as HttpResult.
export type SlackErrorPayload = HttpResultErr;
export type SlackSuccessPayload<T> = HttpResultOk<T>;
export type SlackResult<T> = HttpResult<T>;

/** Resolve Slack credentials from the shared credential provider chain. */
export async function loadSlackCredentials(): Promise<
  {
    botToken: string;
    userToken?: string;
    defaultTeamId?: string;
  } | null
> {
  const botToken =
    (await resolveSecret("SLACK_BOT_TOKEN")) ??
    process.env["SLACK_BOT_TOKEN"] ??
    null;
  if (!botToken) return null;
  const userToken =
    (await resolveSecret("SLACK_USER_TOKEN")) ??
    process.env["SLACK_USER_TOKEN"] ??
    undefined;
  const defaultTeamId = process.env["SLACK_DEFAULT_TEAM_ID"] ?? undefined;
  return {
    botToken,
    ...(userToken ? { userToken } : {}),
    ...(defaultTeamId ? { defaultTeamId } : {}),
  };
}

// ── Slack response envelopes ────────────────────────────────────────────

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { messages?: string[] };
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    email?: string;
    display_name?: string;
    real_name?: string;
  };
}

export interface SlackMessage {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
  files?: SlackFile[];
}

export interface SlackFile {
  id: string;
  created?: number;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  user?: string;
}

interface SlackListResponse<T> extends SlackEnvelope {
  channels?: T[];
  members?: T[];
  messages?: T[];
  files?: T[];
  response_metadata?: {
    next_cursor?: string;
    messages?: string[];
  };
  has_more?: boolean;
}

interface SlackSearchPagination {
  page?: number;
  page_count?: number;
  per_page?: number;
  total_count?: number;
}

interface SlackSearchMessagesResponse extends SlackEnvelope {
  messages?: {
    matches?: SlackMessage[];
    total?: number;
    pagination?: SlackSearchPagination;
  };
}

interface SlackSearchFilesResponse extends SlackEnvelope {
  files?: {
    matches?: SlackFile[];
    total?: number;
    pagination?: SlackSearchPagination;
  };
}

interface SlackPostMessageResponse extends SlackEnvelope {
  channel?: string;
  ts?: string;
  message?: SlackMessage;
}

interface SlackChannelResponse extends SlackEnvelope {
  channel?: SlackChannel;
}

interface SlackUserResponse extends SlackEnvelope {
  user?: SlackUser;
}

interface SlackFileResponse extends SlackEnvelope {
  file?: SlackFile;
}

interface SlackUploadUrlResponse extends SlackEnvelope {
  upload_url?: string;
  file_id?: string;
}

interface SlackCompleteUploadResponse extends SlackEnvelope {
  files?: Array<{ id: string; title?: string }>;
}

// ── Client ──────────────────────────────────────────────────────────────

type SlackTokenKind = "bot" | "user";

export class SlackClient {
  private readonly _botHttp: HttpClient;
  private readonly _userHttp: HttpClient | null;
  private readonly _botToken: string;
  private readonly _defaultTeamId: string | null;
  private readonly _fetch: typeof globalThis.fetch;

  get defaultTeamId(): string | null {
    return this._defaultTeamId;
  }

  get hasUserToken(): boolean {
    return this._userHttp !== null;
  }

  /** Bot token for use with `fetchAttachment` when downloading files. */
  get botAuthHeader(): string {
    return `Bearer ${this._botToken}`;
  }

  constructor(opts: SlackClientOptions) {
    const baseUrl = opts.apiBase ?? SLACK_API_BASE;
    const shared = {
      baseUrl,
      serviceName: "Slack",
      allowedMethods: new Set<"GET" | "POST">(["POST"]),
      rateLimitPerMin: opts.rateLimitPerMin,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    };
    this._botToken = opts.botToken;
    this._botHttp = new HttpClient({
      ...shared,
      authHeader: `Bearer ${opts.botToken}`,
    });
    this._userHttp = opts.userToken
      ? new HttpClient({
          ...shared,
          authHeader: `Bearer ${opts.userToken}`,
        })
      : null;
    this._defaultTeamId = opts.defaultTeamId ?? null;
    this._fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Clear the rate-limit window on both HTTP clients. Test-only. */
  public resetRateLimiter(): void {
    this._botHttp.resetRateLimiter();
    this._userHttp?.resetRateLimiter();
  }

  /**
   * POST a JSON body to a Slack API method, parse the response, and
   * translate `body.ok=false` into an `HttpResultErr` whose `code` is the
   * uppercased Slack error string.
   */
  private async _call<T extends SlackEnvelope>(
    method: string,
    body: Record<string, unknown> = {},
    token: SlackTokenKind = "bot",
  ): Promise<SlackResult<T>> {
    const http = token === "user" ? this._userHttp : this._botHttp;
    if (!http) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        `SLACK_USER_TOKEN is required for ${method}. Set the env var or ` +
          "configure via ~/.connectors/config.yaml.",
        false,
      );
    }
    const raw = await http.request<T>("POST", `/${method}`, { body });
    if (!raw.ok) return raw;
    if (!raw.data.ok) {
      const slackCode = (raw.data.error ?? "").toUpperCase() || "SLACK_ERROR";
      const retriable = slackCode === "RATELIMITED" || slackCode === "RATE_LIMITED";
      return {
        ok: false,
        code: slackCode,
        message: `Slack ${method} returned ${raw.data.error ?? "ok=false"}`,
        retriable,
        status: raw.status,
      };
    }
    return raw;
  }

  // ── Channels ──────────────────────────────────────────────────────────

  public async listChannels(
    types: string,
    limit: number,
  ): Promise<SlackResult<SlackListResponse<SlackChannel>>> {
    return this._call<SlackListResponse<SlackChannel>>("conversations.list", {
      types,
      limit,
    });
  }

  public async getChannel(
    channelId: string,
  ): Promise<SlackResult<SlackChannelResponse>> {
    return this._call<SlackChannelResponse>("conversations.info", {
      channel: channelId,
    });
  }

  public async getChannelHistory(
    channelId: string,
    limit: number,
    oldest?: string,
    latest?: string,
  ): Promise<SlackResult<SlackListResponse<SlackMessage>>> {
    const body: Record<string, unknown> = { channel: channelId, limit };
    if (oldest !== undefined) body["oldest"] = oldest;
    if (latest !== undefined) body["latest"] = latest;
    return this._call<SlackListResponse<SlackMessage>>(
      "conversations.history",
      body,
    );
  }

  public async getThreadReplies(
    channelId: string,
    threadTs: string,
    limit: number,
  ): Promise<SlackResult<SlackListResponse<SlackMessage>>> {
    return this._call<SlackListResponse<SlackMessage>>(
      "conversations.replies",
      { channel: channelId, ts: threadTs, limit },
    );
  }

  // ── Users ─────────────────────────────────────────────────────────────

  public async listUsers(
    limit: number,
  ): Promise<SlackResult<SlackListResponse<SlackUser>>> {
    return this._call<SlackListResponse<SlackUser>>("users.list", { limit });
  }

  public async getUserById(
    userId: string,
  ): Promise<SlackResult<SlackUserResponse>> {
    return this._call<SlackUserResponse>("users.info", { user: userId });
  }

  public async getUserByEmail(
    email: string,
  ): Promise<SlackResult<SlackUserResponse>> {
    return this._call<SlackUserResponse>("users.lookupByEmail", { email });
  }

  // ── Files ─────────────────────────────────────────────────────────────

  public async listFiles(
    channelId: string | undefined,
    userId: string | undefined,
    limit: number,
  ): Promise<SlackResult<SlackListResponse<SlackFile>>> {
    const body: Record<string, unknown> = { count: limit };
    if (channelId !== undefined) body["channel"] = channelId;
    if (userId !== undefined) body["user"] = userId;
    return this._call<SlackListResponse<SlackFile>>("files.list", body);
  }

  public async getFileInfo(
    fileId: string,
  ): Promise<SlackResult<SlackFileResponse>> {
    return this._call<SlackFileResponse>("files.info", { file: fileId });
  }

  // ── Search (user token only) ─────────────────────────────────────────

  public async searchMessages(
    query: string,
    count: number,
  ): Promise<SlackResult<SlackSearchMessagesResponse>> {
    return this._call<SlackSearchMessagesResponse>(
      "search.messages",
      { query, count },
      "user",
    );
  }

  public async searchFiles(
    query: string,
    count: number,
  ): Promise<SlackResult<SlackSearchFilesResponse>> {
    return this._call<SlackSearchFilesResponse>(
      "search.files",
      { query, count },
      "user",
    );
  }

  // ── Messages (write) ──────────────────────────────────────────────────

  public async postMessage(
    body: Record<string, unknown>,
  ): Promise<SlackResult<SlackPostMessageResponse>> {
    return this._call<SlackPostMessageResponse>("chat.postMessage", body);
  }

  public async updateMessage(
    body: Record<string, unknown>,
  ): Promise<SlackResult<SlackPostMessageResponse>> {
    return this._call<SlackPostMessageResponse>("chat.update", body);
  }

  public async deleteMessage(
    channelId: string,
    ts: string,
  ): Promise<SlackResult<SlackEnvelope>> {
    return this._call<SlackEnvelope>("chat.delete", { channel: channelId, ts });
  }

  // ── Reactions ─────────────────────────────────────────────────────────

  public async addReaction(
    channelId: string,
    ts: string,
    name: string,
  ): Promise<SlackResult<SlackEnvelope>> {
    return this._call<SlackEnvelope>("reactions.add", {
      channel: channelId,
      timestamp: ts,
      name,
    });
  }

  public async removeReaction(
    channelId: string,
    ts: string,
    name: string,
  ): Promise<SlackResult<SlackEnvelope>> {
    return this._call<SlackEnvelope>("reactions.remove", {
      channel: channelId,
      timestamp: ts,
      name,
    });
  }

  // ── File upload (2-step external upload) ─────────────────────────────

  public async getUploadUrlExternal(
    filename: string,
    length: number,
    altText?: string,
  ): Promise<SlackResult<SlackUploadUrlResponse>> {
    const body: Record<string, unknown> = { filename, length };
    if (altText !== undefined) body["alt_txt"] = altText;
    return this._call<SlackUploadUrlResponse>(
      "files.getUploadURLExternal",
      body,
    );
  }

  public async completeUploadExternal(
    fileId: string,
    title: string,
    channelId: string | undefined,
    initialComment: string | undefined,
  ): Promise<SlackResult<SlackCompleteUploadResponse>> {
    const body: Record<string, unknown> = {
      files: [{ id: fileId, title }],
    };
    if (channelId !== undefined) body["channel_id"] = channelId;
    if (initialComment !== undefined) body["initial_comment"] = initialComment;
    return this._call<SlackCompleteUploadResponse>(
      "files.completeUploadExternal",
      body,
    );
  }

  /**
   * Raw upload of bytes to the absolute `upload_url` returned by
   * `files.getUploadURLExternal`. Uses POST — Slack's external upload
   * service rejects PUT (responds 405). Slack hosts this on a separate
   * domain, so it doesn't go through the API base URL or the shared
   * retry loop — we use the injected fetch impl directly. Validates the
   * URL scheme via the toolkit's `validateUrl` before making the call.
   */
  public async uploadBytes(
    url: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<void> {
    if (!validateUrl(url)) {
      throw new ConnectorError(
        "VALIDATION_ERROR",
        `Slack upload URL rejected: ${url}`,
        false,
        400,
      );
    }
    const headers: Record<string, string> = {
      "Content-Type": contentType ?? "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
    };
    let response: Response;
    try {
      response = await this._fetch(url, {
        method: "POST",
        headers,
        body: bytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectorError(
        "NETWORK_ERROR",
        `Slack upload PUT failed: ${message}`,
        true,
      );
    }
    if (!response.ok) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        /* ignore */
      }
      throw new ConnectorError(
        response.status >= 500 ? "SERVER_ERROR" : "HTTP_ERROR",
        `Slack upload PUT returned HTTP ${response.status}: ${bodyText.slice(0, 200)}`,
        response.status >= 500,
        response.status,
      );
    }
  }
}
