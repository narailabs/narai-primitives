/**
 * teams_client.ts — Microsoft Graph HTTP client for the Teams connector.
 *
 * Talks to `https://graph.microsoft.com/v1.0/`. Each request:
 *   1. fetches an access token from `TeamsAuth` (cached)
 *   2. sends the request via Node's `fetch`
 *   3. on 401, invalidates the cached token, requests a fresh one, retries once
 *   4. on 429, honours `Retry-After` and backs off
 *   5. on 5xx, retries with exponential backoff
 *   6. surfaces Graph's `{error: {code, message}}` body in the failure code/message
 *
 * Returns the toolkit-style `Result<T>` envelope: connectors using this
 * client can rely on `throwIfHttpError` for the same error-throwing
 * contract as `HttpClient`-backed clients.
 */
import { M365Auth as TeamsAuth } from "../../_m365/auth.js";
import { M365Error as TeamsError } from "../../_m365/error.js";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;

// ── Result envelope ──────────────────────────────────────────────────────────

export interface TeamsResultOk<T> {
  ok: true;
  data: T;
  status: number;
}

export interface TeamsResultErr {
  ok: false;
  code: string;
  message: string;
  retriable: boolean;
  status?: number;
}

export type TeamsResult<T> = TeamsResultOk<T> | TeamsResultErr;

// ── Domain types (kept narrow — only fields we actually return) ──────────────

export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export interface GraphTeam {
  id: string;
  displayName?: string;
  description?: string | null;
  webUrl?: string;
}

export interface GraphChannel {
  id: string;
  displayName?: string;
  description?: string | null;
  membershipType?: string;
  webUrl?: string;
  email?: string;
}

export interface GraphChat {
  id: string;
  topic?: string | null;
  chatType?: string;
  createdDateTime?: string;
  lastUpdatedDateTime?: string;
  webUrl?: string;
}

export interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  jobTitle?: string | null;
}

export interface GraphMessageAttachment {
  id: string;
  contentType?: string;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
}

export interface GraphMessage {
  id: string;
  replyToId?: string | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string | null;
  deletedDateTime?: string | null;
  subject?: string | null;
  importance?: string;
  webUrl?: string | null;
  from?: { user?: { id?: string; displayName?: string } | null } | null;
  body?: { content?: string; contentType?: string };
  attachments?: GraphMessageAttachment[];
  reactions?: Array<{ reactionType?: string; user?: { user?: { id?: string } } }>;
}

export interface GraphOnlineMeeting {
  id: string;
  subject?: string | null;
  startDateTime?: string;
  endDateTime?: string;
  joinWebUrl?: string;
  joinMeetingId?: string | null;
  participants?: unknown;
}

export interface GraphMeetingTranscript {
  id: string;
  meetingOrganizer?: unknown;
  createdDateTime?: string;
  transcriptContentUrl?: string;
}

export interface GraphMeetingRecording {
  id: string;
  createdDateTime?: string;
  recordingContentUrl?: string;
  callId?: string;
}

export interface GraphDriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  file?: { mimeType?: string };
}

export interface GraphSearchHit {
  hitId: string;
  rank?: number;
  summary?: string;
  resource?: {
    id?: string;
    "@odata.type"?: string;
    createdDateTime?: string;
    body?: { content?: string; contentType?: string };
    from?: { user?: { displayName?: string; id?: string } } | null;
    webLink?: string;
    chatId?: string | null;
    channelIdentity?: { teamId?: string; channelId?: string } | null;
  };
}

export interface GraphSearchResponse {
  value: Array<{
    hitsContainers?: Array<{
      hits?: GraphSearchHit[];
      total?: number;
      moreResultsAvailable?: boolean;
    }>;
  }>;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface TeamsClientOptions {
  auth: TeamsAuth;
  baseUrl?: string;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOpts {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: "json" | "text" | "binary";
}

interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

// ── Graph error parsing ──────────────────────────────────────────────────────

interface GraphErrorBody {
  error?: {
    code?: string;
    message?: string;
    innerError?: { code?: string; message?: string };
  };
}

function parseGraphError(
  status: number,
  bodyText: string,
): { code: string; message: string } {
  let code = `HTTP_${status}`;
  let message = bodyText.slice(0, 500);
  try {
    const parsed = JSON.parse(bodyText) as GraphErrorBody;
    if (parsed.error?.code) code = parsed.error.code;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // body wasn't JSON — keep status-derived defaults
  }
  return { code, message };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

// ── TeamsClient ──────────────────────────────────────────────────────────────

export class TeamsClient {
  private readonly _auth: TeamsAuth;
  private readonly _baseUrl: string;
  private readonly _connectTimeoutMs: number;
  private readonly _readTimeoutMs: number;
  private readonly _maxAttempts: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _sleep: (ms: number) => Promise<void>;

  constructor(opts: TeamsClientOptions) {
    this._auth = opts.auth;
    this._baseUrl = (opts.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
    this._connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this._maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._sleep =
      opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  public get tenantId(): string {
    return this._auth.tenantId;
  }

  // ── Core request ───────────────────────────────────────────────────────────

  private _buildUrl(path: string, query?: RequestOpts["query"]): string {
    const isAbsolute = /^https?:\/\//i.test(path);
    const url = isAbsolute
      ? path
      : `${this._baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
  }

  public async request<T>(
    method: HttpMethod,
    path: string,
    opts: RequestOpts = {},
  ): Promise<TeamsResult<T>> {
    const url = this._buildUrl(path, opts.query);
    const responseType = opts.responseType ?? "json";
    let attemptedAuthRetry = false;
    let lastError: TeamsResultErr | null = null;

    for (let attempt = 0; attempt < this._maxAttempts; attempt++) {
      let token: string;
      try {
        token = await this._auth.getAccessToken();
      } catch (err) {
        if (err instanceof TeamsError) {
          return {
            ok: false,
            code: err.code,
            message: err.message,
            retriable: err.retriable,
            ...(err.httpStatus !== undefined ? { status: err.httpStatus } : {}),
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code: "AUTH_ERROR",
          message: `Failed to acquire access token: ${message}`,
          retriable: false,
        };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(),
        this._connectTimeoutMs + this._readTimeoutMs,
      );

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept:
            responseType === "binary"
              ? "*/*"
              : responseType === "text"
                ? "text/plain"
                : "application/json",
          ...(opts.headers ?? {}),
        };
        const hasBody = opts.body !== undefined && opts.body !== null;
        const isRaw =
          opts.body instanceof Uint8Array ||
          opts.body instanceof ArrayBuffer ||
          typeof opts.body === "string";
        if (
          hasBody &&
          !isRaw &&
          !("Content-Type" in headers) &&
          !("content-type" in headers)
        ) {
          headers["Content-Type"] = "application/json";
        }
        const init: RequestInit = {
          method,
          headers,
          signal: ctrl.signal,
          ...(hasBody
            ? {
                body: isRaw
                  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (opts.body as any)
                  : JSON.stringify(opts.body),
              }
            : {}),
        };

        const response = await this._fetch(url, init);
        const status = response.status;

        // 401 — try once with a fresh token.
        if (status === 401 && !attemptedAuthRetry) {
          attemptedAuthRetry = true;
          this._auth.invalidate();
          await this._consumeBody(response);
          continue;
        }

        if (status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          lastError = {
            ok: false,
            code: "TooManyRequests",
            message: `Graph rate limit hit`,
            retriable: true,
            status,
          };
          if (attempt < this._maxAttempts - 1) {
            await this._sleep(retryAfter ?? Math.min(30_000, 500 * 2 ** attempt));
            continue;
          }
          return lastError;
        }

        if (status >= 500) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          const body = await this._safeText(response);
          const parsed = parseGraphError(status, body);
          lastError = {
            ok: false,
            code: parsed.code,
            message: parsed.message,
            retriable: true,
            status,
          };
          if (attempt < this._maxAttempts - 1) {
            await this._sleep(retryAfter ?? Math.min(30_000, 500 * 2 ** attempt));
            continue;
          }
          return lastError;
        }

        if (!response.ok) {
          const body = await this._safeText(response);
          const parsed = parseGraphError(status, body);
          return {
            ok: false,
            code: parsed.code,
            message: parsed.message,
            retriable: false,
            status,
          };
        }

        if (status === 204) {
          return { ok: true, data: {} as T, status };
        }

        if (responseType === "binary") {
          const buf = await response.arrayBuffer();
          const cd = response.headers.get("content-disposition");
          const data: BinaryResponse = {
            bytes: new Uint8Array(buf),
            contentType:
              response.headers.get("content-type") ??
              "application/octet-stream",
            filename: parseContentDispositionFilename(cd) ?? filenameFromPath(path),
          };
          return { ok: true, data: data as unknown as T, status };
        }
        if (responseType === "text") {
          const text = await response.text();
          return { ok: true, data: text as unknown as T, status };
        }
        const data = (await response.json()) as T;
        return { ok: true, data, status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof DOMException || /abort/i.test(message);
        lastError = {
          ok: false,
          code: aborted ? "Timeout" : "NetworkError",
          message: aborted ? "Request timed out" : message,
          retriable: true,
        };
        if (attempt < this._maxAttempts - 1) {
          await this._sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        return lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    return (
      lastError ?? {
        ok: false,
        code: "Unknown",
        message: "Exhausted retries without a response",
        retriable: true,
      }
    );
  }

  private async _safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  private async _consumeBody(response: Response): Promise<void> {
    try {
      await response.text();
    } catch {
      /* ignore */
    }
  }

  // ── Pagination helper ──────────────────────────────────────────────────────

  /**
   * Walk `@odata.nextLink` pages, accumulating items from `value`, until
   * `max` items collected or no nextLink remains. Returns the flat array plus
   * a `truncated` flag indicating that more results exist on the server.
   */
  public async paginate<T>(
    path: string,
    max: number,
    initialQuery?: RequestOpts["query"],
  ): Promise<TeamsResult<{ items: T[]; truncated: boolean }>> {
    const items: T[] = [];
    let currentPath: string = path;
    let currentQuery: RequestOpts["query"] | undefined = initialQuery;
    let truncated = false;
    while (items.length < max) {
      const result: TeamsResult<GraphCollection<T>> = await this.request<
        GraphCollection<T>
      >("GET", currentPath, currentQuery !== undefined ? { query: currentQuery } : {});
      if (!result.ok) return result;
      const page = Array.isArray(result.data.value) ? result.data.value : [];
      for (const it of page) {
        if (items.length >= max) {
          truncated = true;
          break;
        }
        items.push(it);
      }
      const next = result.data["@odata.nextLink"];
      if (!next) break;
      if (items.length >= max) {
        truncated = true;
        break;
      }
      // Use the absolute nextLink URL directly; the URL builder accepts absolute paths.
      currentPath = next;
      currentQuery = undefined;
    }
    return { ok: true, data: { items, truncated }, status: 200 };
  }

  // ── Directory ──────────────────────────────────────────────────────────────

  public async listJoinedTeams(max: number): Promise<TeamsResult<{ items: GraphTeam[]; truncated: boolean }>> {
    return this.paginate<GraphTeam>("/me/joinedTeams", max);
  }

  public async listChannels(
    teamId: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphChannel[]; truncated: boolean }>> {
    return this.paginate<GraphChannel>(`/teams/${encodeURIComponent(teamId)}/channels`, max);
  }

  public async getChannel(teamId: string, channelId: string): Promise<TeamsResult<GraphChannel>> {
    return this.request<GraphChannel>(
      "GET",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
    );
  }

  public async listChats(max: number): Promise<TeamsResult<{ items: GraphChat[]; truncated: boolean }>> {
    return this.paginate<GraphChat>("/me/chats", max, { $top: Math.min(max, 50) });
  }

  public async listUsers(max: number): Promise<TeamsResult<{ items: GraphUser[]; truncated: boolean }>> {
    return this.paginate<GraphUser>("/users", max, { $top: Math.min(max, 100) });
  }

  public async getUser(idOrUpn: string): Promise<TeamsResult<GraphUser>> {
    return this.request<GraphUser>("GET", `/users/${encodeURIComponent(idOrUpn)}`);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  public async listChannelMessages(
    teamId: string,
    channelId: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphMessage[]; truncated: boolean }>> {
    return this.paginate<GraphMessage>(
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
      max,
      { $top: Math.min(max, 50) },
    );
  }

  public async getMessageReplies(
    teamId: string,
    channelId: string,
    msgId: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphMessage[]; truncated: boolean }>> {
    return this.paginate<GraphMessage>(
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}/replies`,
      max,
    );
  }

  public async listChatMessages(
    chatId: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphMessage[]; truncated: boolean }>> {
    return this.paginate<GraphMessage>(
      `/chats/${encodeURIComponent(chatId)}/messages`,
      max,
      { $top: Math.min(max, 50) },
    );
  }

  public async getMessage(
    teamId: string,
    channelId: string,
    msgId: string,
  ): Promise<TeamsResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "GET",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}`,
    );
  }

  public async getChatMessage(
    chatId: string,
    msgId: string,
  ): Promise<TeamsResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "GET",
      `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}`,
    );
  }

  public async postChannelMessage(
    teamId: string,
    channelId: string,
    body: Record<string, unknown>,
  ): Promise<TeamsResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "POST",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
      { body },
    );
  }

  public async replyToChannelMessage(
    teamId: string,
    channelId: string,
    msgId: string,
    body: Record<string, unknown>,
  ): Promise<TeamsResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "POST",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}/replies`,
      { body },
    );
  }

  public async postChatMessage(
    chatId: string,
    body: Record<string, unknown>,
  ): Promise<TeamsResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "POST",
      `/chats/${encodeURIComponent(chatId)}/messages`,
      { body },
    );
  }

  public async updateMessage(
    teamId: string,
    channelId: string,
    msgId: string,
    body: Record<string, unknown>,
  ): Promise<TeamsResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "PATCH",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}`,
      { body },
    );
  }

  public async softDeleteMessage(
    teamId: string,
    channelId: string,
    msgId: string,
  ): Promise<TeamsResult<null>> {
    return this.request<null>(
      "POST",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}/softDelete`,
    );
  }

  public async setReaction(
    teamId: string,
    channelId: string,
    msgId: string,
    reactionType: string,
  ): Promise<TeamsResult<null>> {
    return this.request<null>(
      "POST",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}/setReaction`,
      { body: { reactionType } },
    );
  }

  public async unsetReaction(
    teamId: string,
    channelId: string,
    msgId: string,
    reactionType: string,
  ): Promise<TeamsResult<null>> {
    return this.request<null>(
      "POST",
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}/unsetReaction`,
      { body: { reactionType } },
    );
  }

  public async searchMessages(query: string, max: number): Promise<TeamsResult<GraphSearchResponse>> {
    const body = {
      requests: [
        {
          entityTypes: ["chatMessage"],
          query: { queryString: query },
          from: 0,
          size: Math.max(1, Math.min(max, 500)),
        },
      ],
    };
    return this.request<GraphSearchResponse>("POST", "/search/query", { body });
  }

  // ── Meetings ───────────────────────────────────────────────────────────────

  public async listOnlineMeetings(
    filter: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphOnlineMeeting[]; truncated: boolean }>> {
    return this.paginate<GraphOnlineMeeting>(
      "/me/onlineMeetings",
      max,
      { $filter: filter },
    );
  }

  public async getOnlineMeeting(meetingId: string): Promise<TeamsResult<GraphOnlineMeeting>> {
    return this.request<GraphOnlineMeeting>(
      "GET",
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}`,
    );
  }

  public async listMeetingTranscripts(
    meetingId: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphMeetingTranscript[]; truncated: boolean }>> {
    return this.paginate<GraphMeetingTranscript>(
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
      max,
    );
  }

  /** Returns the transcript content as plain VTT text. */
  public async getMeetingTranscriptContent(
    meetingId: string,
    transcriptId: string,
  ): Promise<TeamsResult<string>> {
    return this.request<string>(
      "GET",
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
      { query: { $format: "text/vtt" }, responseType: "text" },
    );
  }

  public async listMeetingRecordings(
    meetingId: string,
    max: number,
  ): Promise<TeamsResult<{ items: GraphMeetingRecording[]; truncated: boolean }>> {
    return this.paginate<GraphMeetingRecording>(
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings`,
      max,
    );
  }

  public async getMeetingRecordingContent(
    meetingId: string,
    recordingId: string,
  ): Promise<TeamsResult<BinaryResponse>> {
    return this.request<BinaryResponse>(
      "GET",
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recordingId)}/content`,
      { responseType: "binary" },
    );
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  /**
   * Upload bytes to the signed-in user's OneDrive under `Apps/Teams Uploads/`.
   * Returns the resulting drive item, which can be attached to a Teams
   * message via the `attachments[].contentUrl` reference shape.
   */
  public async uploadAttachmentToOneDrive(
    filename: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<TeamsResult<GraphDriveItem>> {
    const safeFilename = encodeURIComponent(filename);
    return this.request<GraphDriveItem>(
      "PUT",
      `/me/drive/root:/Apps/Teams Uploads/${safeFilename}:/content`,
      {
        body: bytes,
        headers: { "Content-Type": contentType },
      },
    );
  }
}

// ── small helpers (kept local — duplicated from toolkit to avoid coupling) ────

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1] ?? null;
}

function filenameFromPath(path: string): string {
  const clean = path.split("?")[0] ?? path;
  const segments = clean.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "download";
}
