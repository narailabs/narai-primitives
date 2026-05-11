/**
 * confluence_client.ts — Atlassian Confluence REST v1 HTTP client.
 *
 * Thin wrapper over the shared `HttpClient` in `narai-primitives/toolkit`:
 * supplies Basic-auth + the Atlassian-Token header on multipart uploads,
 * normalizes attachment-download paths, and exposes the Confluence endpoint
 * surface. All retry/throttle/timeout/URL-validation logic comes from the
 * shared client.
 */
import {
  HttpClient,
  type BinaryResponse,
  type HttpResult,
  type HttpResultErr,
  type HttpResultOk,
} from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

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

export type ConfluenceErrorPayload = HttpResultErr;
export type ConfluenceSuccessPayload<T> = HttpResultOk<T>;
export type ConfluenceResult<T> = HttpResult<T>;

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
  private readonly _http: HttpClient;
  private readonly _authHeader: string;
  private readonly _site: string;

  constructor(opts: ConfluenceClientOptions) {
    const basic = Buffer.from(
      `${opts.email}:${opts.apiToken}`,
      "utf-8",
    ).toString("base64");
    this._authHeader = `Basic ${basic}`;
    this._site = opts.siteUrl.replace(/\/+$/, "");
    this._http = new HttpClient({
      baseUrl: opts.siteUrl,
      authHeader: this._authHeader,
      serviceName: "Confluence",
      allowedMethods: new Set<HttpMethod>(["GET", "POST", "PUT", "DELETE"]),
      rateLimitPerMin: opts.rateLimitPerMin,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    });
  }

  public get siteUrl(): string {
    return this._site;
  }

  public get authHeader(): string {
    return this._authHeader;
  }

  public async request<T = unknown>(
    method: HttpMethod,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined | null>;
      headers?: Record<string, string>;
      body?: object | FormData;
    } = {},
  ): Promise<ConfluenceResult<T>> {
    return this._http.request<T>(method, path, {
      query: init.query,
      headers: init.headers,
      body: init.body,
    });
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
  ): Promise<ConfluenceResult<BinaryResponse>> {
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
    // Derive the fallback filename from the *original* downloadPath so a
    // download of "/foo/bar.png" still gets `bar.png` when the server
    // omits Content-Disposition. Default to "attachment" when the path
    // has no tail segment (e.g. "/" or "").
    const tail = downloadPath.split("/").filter(Boolean).pop();
    let fallback = "attachment";
    if (tail) {
      try {
        fallback = decodeURIComponent(tail);
      } catch {
        fallback = tail;
      }
    }
    return this._http.request<BinaryResponse>("GET", withMount, {
      responseType: "binary",
      filenameFallback: fallback,
    });
  }

  public async createPage(
    payload: object,
  ): Promise<ConfluenceResult<ConfluenceContent>> {
    return this.request("POST", "/wiki/rest/api/content", { body: payload });
  }

  public async updatePage(
    id: string,
    payload: object,
  ): Promise<ConfluenceResult<ConfluenceContent>> {
    return this.request("PUT", `/wiki/rest/api/content/${id}`, {
      body: payload,
    });
  }

  public async deletePage(
    id: string,
  ): Promise<ConfluenceResult<Record<string, never>>> {
    return this.request("DELETE", `/wiki/rest/api/content/${id}`);
  }

  public async addComment(
    payload: object,
  ): Promise<ConfluenceResult<ConfluenceRawCreatedContent>> {
    return this.request("POST", "/wiki/rest/api/content", { body: payload });
  }

  public async postAttachment(
    pageId: string,
    files: Array<{ filename: string; bytes: Uint8Array; mimeType?: string }>,
  ): Promise<ConfluenceResult<ConfluenceAttachmentUploadResponse>> {
    const formData = new FormData();
    for (const f of files) {
      const blob = new Blob([f.bytes], {
        type: f.mimeType ?? "application/octet-stream",
      });
      formData.append("file", blob, f.filename);
    }
    return this.request(
      "POST",
      `/wiki/rest/api/content/${pageId}/child/attachment`,
      {
        body: formData,
        headers: { "X-Atlassian-Token": "no-check" },
      },
    );
  }
}

// ── Response interfaces (unchanged) ────────────────────────────────────

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

export interface ConfluenceRawCreatedContent {
  id: string;
  history?: { createdDate?: string; createdBy?: { displayName?: string } };
}

export interface ConfluenceAttachmentUploadResponse {
  results: Array<{
    id: string;
    title?: string;
    metadata?: { mediaType?: string };
    extensions?: { fileSize?: number };
  }>;
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
