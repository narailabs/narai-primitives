/**
 * outlook_client.ts — Microsoft Graph HTTP client for the Outlook connector.
 *
 * Talks to `https://graph.microsoft.com/v1.0/`. Each request:
 *   1. fetches an access token from `OutlookAuth` (cached)
 *   2. sends the request via Node's `fetch`
 *   3. on 401, invalidates the cached token, requests a fresh one, retries once
 *   4. on 429, honours `Retry-After` and backs off
 *   5. on 5xx, retries with exponential backoff
 *   6. surfaces Graph's `{error: {code, message}}` body in the failure code/message
 *
 * Returns the toolkit-style `Result<T>` envelope: connectors using this
 * client can rely on `throwIfHttpError` for the same error-throwing
 * contract as `HttpClient`-backed clients.
 *
 * 202 Accepted responses (used by /sendMail and /reply) are surfaced as
 * `{ ok: true, data: { accepted: true }, status: 202 }` — these endpoints
 * intentionally return no body.
 */
import { OutlookAuth } from "./outlook_auth.js";
import { OutlookError } from "./outlook_error.js";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;

// ── Result envelope ──────────────────────────────────────────────────────────

export interface OutlookResultOk<T> {
  ok: true;
  data: T;
  status: number;
}

export interface OutlookResultErr {
  ok: false;
  code: string;
  message: string;
  retriable: boolean;
  status?: number;
}

export type OutlookResult<T> = OutlookResultOk<T> | OutlookResultErr;

// ── Domain types (kept narrow — only fields we actually return) ──────────────

export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export interface GraphEmailAddress {
  address?: string;
  name?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphMailFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string | null;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
  wellKnownName?: string | null;
}

export interface GraphMessageAttachment {
  id: string;
  "@odata.type"?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
  lastModifiedDateTime?: string;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  hasAttachments?: boolean;
  subject?: string | null;
  importance?: string;
  isRead?: boolean;
  isDraft?: boolean;
  webLink?: string | null;
  parentFolderId?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  body?: { content?: string; contentType?: string };
  bodyPreview?: string | null;
  attachments?: GraphMessageAttachment[];
}

export interface GraphSearchHit {
  hitId: string;
  rank?: number;
  summary?: string;
  resource?: GraphMessage & { "@odata.type"?: string };
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

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface OutlookClientOptions {
  auth: OutlookAuth;
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

// ── OutlookClient ────────────────────────────────────────────────────────────

export class OutlookClient {
  private readonly _auth: OutlookAuth;
  private readonly _baseUrl: string;
  private readonly _connectTimeoutMs: number;
  private readonly _readTimeoutMs: number;
  private readonly _maxAttempts: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _sleep: (ms: number) => Promise<void>;

  constructor(opts: OutlookClientOptions) {
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
  ): Promise<OutlookResult<T>> {
    const url = this._buildUrl(path, opts.query);
    const responseType = opts.responseType ?? "json";
    let attemptedAuthRetry = false;
    let lastError: OutlookResultErr | null = null;

    for (let attempt = 0; attempt < this._maxAttempts; attempt++) {
      let token: string;
      try {
        token = await this._auth.getAccessToken();
      } catch (err) {
        if (err instanceof OutlookError) {
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

        if (status === 202 || status === 204) {
          await this._consumeBody(response);
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
  ): Promise<OutlookResult<{ items: T[]; truncated: boolean }>> {
    const items: T[] = [];
    let currentPath: string = path;
    let currentQuery: RequestOpts["query"] | undefined = initialQuery;
    let truncated = false;
    while (items.length < max) {
      const result: OutlookResult<GraphCollection<T>> = await this.request<
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

  // ── Messages ───────────────────────────────────────────────────────────────

  public async listMessages(
    folderId: string,
    max: number,
    orderBy?: string,
  ): Promise<OutlookResult<{ items: GraphMessage[]; truncated: boolean }>> {
    const query: Record<string, string | number> = {
      $top: Math.min(max, 50),
      $orderby: orderBy ?? "receivedDateTime desc",
    };
    return this.paginate<GraphMessage>(
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
      max,
      query,
    );
  }

  public async getMessage(
    messageId: string,
    expand?: string[],
  ): Promise<OutlookResult<GraphMessage>> {
    const query: Record<string, string> = {};
    if (expand && expand.length > 0) query["$expand"] = expand.join(",");
    return this.request<GraphMessage>(
      "GET",
      `/me/messages/${encodeURIComponent(messageId)}`,
      Object.keys(query).length > 0 ? { query } : {},
    );
  }

  public async searchMessages(
    query: string,
    max: number,
  ): Promise<OutlookResult<GraphSearchResponse>> {
    const body = {
      requests: [
        {
          entityTypes: ["message"],
          query: { queryString: query },
          from: 0,
          size: Math.max(1, Math.min(max, 100)),
        },
      ],
    };
    return this.request<GraphSearchResponse>("POST", "/search/query", { body });
  }

  // ── Folders ────────────────────────────────────────────────────────────────

  public async listFolders(
    max: number,
  ): Promise<OutlookResult<{ items: GraphMailFolder[]; truncated: boolean }>> {
    return this.paginate<GraphMailFolder>("/me/mailFolders", max, {
      $top: Math.min(max, 50),
    });
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  public async listAttachments(
    messageId: string,
  ): Promise<OutlookResult<GraphCollection<GraphMessageAttachment>>> {
    return this.request<GraphCollection<GraphMessageAttachment>>(
      "GET",
      `/me/messages/${encodeURIComponent(messageId)}/attachments`,
    );
  }

  public async listAttachmentMetadata(
    messageId: string,
    attachmentId: string,
  ): Promise<OutlookResult<GraphMessageAttachment>> {
    return this.request<GraphMessageAttachment>(
      "GET",
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  public async getAttachmentValue(
    messageId: string,
    attachmentId: string,
  ): Promise<OutlookResult<BinaryResponse>> {
    return this.request<BinaryResponse>(
      "GET",
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
      { responseType: "binary" },
    );
  }

  // ── Write actions ──────────────────────────────────────────────────────────

  public async sendMail(
    payload: Record<string, unknown>,
  ): Promise<OutlookResult<Record<string, never>>> {
    return this.request<Record<string, never>>(
      "POST",
      "/me/sendMail",
      { body: payload },
    );
  }

  public async replyToMessage(
    messageId: string,
    payload: Record<string, unknown>,
  ): Promise<OutlookResult<Record<string, never>>> {
    return this.request<Record<string, never>>(
      "POST",
      `/me/messages/${encodeURIComponent(messageId)}/reply`,
      { body: payload },
    );
  }

  public async moveMessage(
    messageId: string,
    destinationId: string,
  ): Promise<OutlookResult<GraphMessage>> {
    return this.request<GraphMessage>(
      "POST",
      `/me/messages/${encodeURIComponent(messageId)}/move`,
      { body: { destinationId } },
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
