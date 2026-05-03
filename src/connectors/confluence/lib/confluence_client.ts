/**
 * confluence_client.ts — read-only Atlassian Confluence REST v1 HTTP client.
 * Shares the Basic-auth + rate-limit + retry design with jira_client.ts.
 */
import { validateUrl } from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";

type HttpMethod = "GET";
const ALLOWED_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["GET"]);

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_PER_MIN = 60;
const MAX_ATTEMPTS = 4;

export interface ConfluenceClientOptions {
  siteUrl: string;
  email: string;
  apiToken: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface ConfluenceErrorPayload {
  ok: false;
  code: string;
  message: string;
  retriable: boolean;
  status?: number;
}

export interface ConfluenceSuccessPayload<T> {
  ok: true;
  data: T;
  status: number;
}

export type ConfluenceResult<T> =
  | ConfluenceSuccessPayload<T>
  | ConfluenceErrorPayload;

export async function loadConfluenceCredentials(): Promise<
  { siteUrl: string; email: string; apiToken: string } | null
> {
  const siteUrl = process.env["CONFLUENCE_SITE_URL"] ?? null;
  const email =
    (await resolveSecret("CONFLUENCE_EMAIL")) ??
    process.env["CONFLUENCE_EMAIL"] ??
    null;
  const apiToken =
    (await resolveSecret("CONFLUENCE_API_TOKEN")) ??
    process.env["CONFLUENCE_API_TOKEN"] ??
    null;
  if (!siteUrl || !email || !apiToken) return null;
  return { siteUrl, email, apiToken };
}

export class ConfluenceClient {
  private readonly _site: string;
  private readonly _authHeader: string;
  private readonly _rateLimitPerMin: number;
  private readonly _connectTimeoutMs: number;
  private readonly _readTimeoutMs: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _sleep: (ms: number) => Promise<void>;
  private _requestTimestamps: number[] = [];

  constructor(opts: ConfluenceClientOptions) {
    if (!validateUrl(opts.siteUrl)) {
      throw new Error(`Invalid Confluence site URL: ${opts.siteUrl}`);
    }
    this._site = opts.siteUrl.replace(/\/+$/, "");
    const basic = Buffer.from(
      `${opts.email}:${opts.apiToken}`,
      "utf-8",
    ).toString("base64");
    this._authHeader = `Basic ${basic}`;
    this._rateLimitPerMin = opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this._fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._sleep =
      opts.sleepImpl ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  private async _throttle(): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    this._requestTimestamps = this._requestTimestamps.filter((t) => t > cutoff);
    if (this._requestTimestamps.length >= this._rateLimitPerMin) {
      const oldest = this._requestTimestamps[0] ?? now;
      const waitMs = Math.max(0, 60_000 - (now - oldest));
      if (waitMs > 0) await this._sleep(waitMs);
      this._requestTimestamps = this._requestTimestamps.filter(
        (t) => t > Date.now() - 60_000,
      );
    }
    this._requestTimestamps.push(Date.now());
  }

  public buildUrl(path: string, query?: Record<string, unknown>): string {
    const relative = path.startsWith("/") ? path : `/${path}`;
    const base = `${this._site}${relative}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  public async request<T = unknown>(
    method: HttpMethod,
    path: string,
    init: { query?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ): Promise<ConfluenceResult<T>> {
    if (!ALLOWED_METHODS.has(method)) {
      return {
        ok: false,
        code: "METHOD_NOT_ALLOWED",
        message: `Method ${method} is not permitted`,
        retriable: false,
      };
    }
    const url = this.buildUrl(path, init.query);
    if (!validateUrl(url)) {
      return {
        ok: false,
        code: "INVALID_URL",
        message: `URL rejected: ${url}`,
        retriable: false,
      };
    }

    let lastError: ConfluenceErrorPayload | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await this._throttle();
      const readCtrl = new AbortController();
      const readTimer = setTimeout(
        () => readCtrl.abort(),
        this._connectTimeoutMs + this._readTimeoutMs,
      );
      try {
        const response = await this._fetch(url, {
          method,
          headers: {
            Authorization: this._authHeader,
            Accept: "application/json",
            ...(init.headers ?? {}),
          },
          signal: readCtrl.signal,
        });
        const status = response.status;
        if (status === 429 || status >= 500) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          lastError = {
            ok: false,
            code: status === 429 ? "RATE_LIMITED" : "SERVER_ERROR",
            message: `Confluence returned HTTP ${status}`,
            retriable: true,
            status,
          };
          if (attempt < MAX_ATTEMPTS - 1) {
            await this._sleep(retryAfter ?? Math.min(30_000, 500 * 2 ** attempt));
            continue;
          }
          return lastError;
        }
        if (!response.ok) {
          let body = "";
          try {
            body = await response.text();
          } catch { /* ignore */ }
          return {
            ok: false,
            code: classifyHttpStatus(status),
            message: `Confluence HTTP ${status}: ${truncate(body, 200)}`,
            retriable: false,
            status,
          };
        }
        const data = (await response.json()) as T;
        return { ok: true, data, status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof DOMException || /abort/i.test(message);
        lastError = {
          ok: false,
          code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
          message: aborted ? "Request timed out" : message,
          retriable: true,
        };
        if (attempt < MAX_ATTEMPTS - 1) {
          await this._sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        return lastError;
      } finally {
        clearTimeout(readTimer);
      }
    }
    return (
      lastError ?? {
        ok: false,
        code: "UNKNOWN",
        message: "Exhausted retries without a response",
        retriable: true,
      }
    );
  }

  public async searchCql(
    cql: string,
    limit: number,
    start = 0,
  ): Promise<ConfluenceResult<ConfluenceSearchResponse>> {
    return this.request<ConfluenceSearchResponse>(
      "GET",
      "/wiki/rest/api/content/search",
      { query: { cql, limit, start, expand: "space,version" } },
    );
  }

  public async getContent(
    id: string,
    expand: string[] = ["body.storage", "space", "version"],
  ): Promise<ConfluenceResult<ConfluenceContent>> {
    return this.request<ConfluenceContent>(
      "GET",
      `/wiki/rest/api/content/${id}`,
      { query: { expand: expand.join(",") } },
    );
  }

  public async getSpace(
    spaceKey: string,
  ): Promise<ConfluenceResult<ConfluenceSpace>> {
    return this.request<ConfluenceSpace>(
      "GET",
      `/wiki/rest/api/space/${spaceKey}`,
      { query: { expand: "description,homepage" } },
    );
  }

  public async listAttachments(
    pageId: string,
    limit = 25,
    start = 0,
  ): Promise<ConfluenceResult<ConfluenceAttachmentList>> {
    return this.request<ConfluenceAttachmentList>(
      "GET",
      `/wiki/rest/api/content/${pageId}/child/attachment`,
      { query: { limit, start } },
    );
  }

  public async getComments(
    pageId: string,
    limit = 50,
  ): Promise<ConfluenceResult<ConfluenceCommentList>> {
    const raw = await this.request<ConfluenceRawCommentList>(
      "GET",
      `/wiki/rest/api/content/${pageId}/child/comment`,
      { query: { expand: "body.view,history,version", limit } },
    );
    if (!raw.ok) return raw;
    const results: ConfluenceComment[] = (raw.data.results ?? []).map((c) => ({
      id: c.id,
      author: c.history?.createdBy?.displayName ?? "",
      created: c.history?.createdDate ?? "",
      version: c.version?.number ?? 0,
      body_plain: htmlToPlain(c.body?.view?.value ?? ""),
    }));
    return {
      ok: true,
      status: raw.status,
      data: {
        results,
        ...(raw.data.size !== undefined ? { size: raw.data.size } : {}),
        ...(raw.data.start !== undefined ? { start: raw.data.start } : {}),
        ...(raw.data.limit !== undefined ? { limit: raw.data.limit } : {}),
      },
    };
  }

  public async getAttachmentDownload(
    downloadPath: string,
  ): Promise<
    ConfluenceResult<{
      bytes: Uint8Array;
      contentType: string;
      filename: string;
    }>
  > {
    // Atlassian Cloud serves Confluence at `/wiki/...`; the `_links.download`
    // value the API returns is relative to that mount, e.g.
    // `/download/attachments/65859/file.txt?...`. Prepend `/wiki` if missing
    // so we don't request the apex path (which 404s).
    const normalized = downloadPath.startsWith("/")
      ? downloadPath
      : `/${downloadPath}`;
    const withMount = normalized.startsWith("/wiki/")
      ? normalized
      : `/wiki${normalized}`;
    const url = this.buildUrl(withMount);
    if (!validateUrl(url)) {
      return {
        ok: false,
        code: "INVALID_URL",
        message: `URL rejected: ${url}`,
        retriable: false,
      };
    }

    await this._throttle();
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      this._connectTimeoutMs + this._readTimeoutMs,
    );
    try {
      const response = await this._fetch(url, {
        method: "GET",
        headers: {
          Authorization: this._authHeader,
          Accept: "*/*",
        },
        signal: ctrl.signal,
      });
      const status = response.status;
      if (!response.ok) {
        return {
          ok: false,
          code: classifyHttpStatus(status),
          message: `Confluence HTTP ${status} while downloading ${downloadPath}`,
          retriable: status === 429 || status >= 500,
          status,
        };
      }
      const buf = await response.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const filename =
        parseContentDispositionFilename(
          response.headers.get("content-disposition"),
        ) ?? filenameFromPath(downloadPath);
      return { ok: true, data: { bytes, contentType, filename }, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = err instanceof DOMException || /abort/i.test(message);
      return {
        ok: false,
        code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
        message: aborted ? "Request timed out" : message,
        retriable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public get siteUrl(): string {
    return this._site;
  }

  public get authHeader(): string {
    return this._authHeader;
  }
}

export interface ConfluenceContent {
  id: string;
  title?: string;
  version?: { number?: number; when?: string };
  space?: { key?: string };
  body?: { storage?: { value?: string } };
}

export interface ConfluenceSearchResponse {
  size?: number;
  totalSize?: number;
  results: ConfluenceContent[];
  limit?: number;
  start?: number;
}

export interface ConfluenceSpace {
  key: string;
  name?: string;
  type?: string;
  description?: { plain?: { value?: string } };
  homepage?: { id?: string };
}

export interface ConfluenceAttachment {
  id: string;
  title?: string;
  metadata?: { mediaType?: string };
  extensions?: { fileSize?: number; comment?: string };
  version?: { number?: number; when?: string };
  _links?: { download?: string; webui?: string };
}

export interface ConfluenceAttachmentList {
  results: ConfluenceAttachment[];
  size?: number;
  start?: number;
  limit?: number;
}

export interface ConfluenceComment {
  id: string;
  author: string;
  created: string;
  version: number;
  body_plain: string;
}

export interface ConfluenceCommentList {
  results: ConfluenceComment[];
  size?: number;
  start?: number;
  limit?: number;
}

interface ConfluenceRawComment {
  id: string;
  history?: { createdBy?: { displayName?: string }; createdDate?: string };
  version?: { number?: number };
  body?: { view?: { value?: string } };
}

interface ConfluenceRawCommentList {
  results?: ConfluenceRawComment[];
  size?: number;
  start?: number;
  limit?: number;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return "BAD_REQUEST";
  return "HTTP_ERROR";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match && match[1] ? match[1].trim() : null;
}

function filenameFromPath(p: string): string {
  const tail = p.split("/").filter(Boolean).pop() ?? "attachment";
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

const BLOCK_TAGS_RE =
  /<\s*\/?(p|div|br|li|h[1-6]|blockquote|tr|pre)[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

export function htmlToPlain(html: string): string {
  if (!html) return "";
  const withBreaks = html.replace(BLOCK_TAGS_RE, "\n\n");
  const stripped = withBreaks.replace(TAG_RE, "");
  const decoded = decodeEntities(stripped);
  return decoded.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}
