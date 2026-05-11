/**
 * notion_client.ts — Notion Public API client.
 *
 * Thin wrapper over the shared `HttpClient` in `narai-primitives/toolkit`:
 * supplies Bearer auth, the `Notion-Version` default header, and the
 * Notion-specific endpoint methods. All retry, throttle, timeout, and
 * URL-validation logic comes from the shared client.
 *
 * The `POST_READ_ONLY` pseudo-method is preserved (it maps to POST) for
 * backward compatibility with existing read-action callers.
 */
import {
  HttpClient,
  type HttpResult,
  type HttpResultErr,
  type HttpResultOk,
} from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";

type NotionMethod = "GET" | "POST" | "POST_READ_ONLY" | "PATCH" | "DELETE";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

export interface NotionClientOptions {
  token: string;
  apiBase?: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

// Back-compat type aliases — same shape as HttpResult.
export type NotionErrorPayload = HttpResultErr;
export type NotionSuccessPayload<T> = HttpResultOk<T>;
export type NotionResult<T> = HttpResult<T>;

export async function loadNotionCredentials(): Promise<
  { token: string } | null
> {
  const token =
    (await resolveSecret("NOTION_TOKEN")) ??
    process.env["NOTION_TOKEN"] ??
    null;
  if (!token) return null;
  return { token };
}

export class NotionClient {
  private readonly _http: HttpClient;
  private _workspaceId: string | null = null;

  get workspaceId(): string | null {
    return this._workspaceId;
  }

  constructor(opts: NotionClientOptions) {
    this._http = new HttpClient({
      baseUrl: opts.apiBase ?? NOTION_API_BASE,
      authHeader: `Bearer ${opts.token}`,
      serviceName: "Notion",
      allowedMethods: new Set(["GET", "POST", "PATCH", "DELETE"]),
      defaultHeaders: { "Notion-Version": NOTION_VERSION },
      rateLimitPerMin: opts.rateLimitPerMin,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    });
  }

  /**
   * Best-effort lookup of the workspace id via `GET /v1/users/me`. Never
   * throws: on any failure `workspaceId` remains `null` and the scope
   * callback demotes to the global tier.
   */
  public async init(): Promise<void> {
    try {
      const result = await this.request<{ bot?: { workspace_id?: string } }>(
        "GET",
        "/v1/users/me",
      );
      if (result.ok) {
        this._workspaceId = result.data.bot?.workspace_id ?? null;
      } else {
        process.stderr.write(
          `[notion] init: workspaceId lookup failed (${result.code})\n`,
        );
        this._workspaceId = null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[notion] init: workspaceId lookup threw (${msg})\n`,
      );
      this._workspaceId = null;
    }
  }

  public async request<T>(
    method: NotionMethod,
    relPath: string,
    body: Record<string, unknown> | null = null,
  ): Promise<NotionResult<T>> {
    const httpMethod = method === "POST_READ_ONLY" ? "POST" : method;
    return this._http.request<T>(httpMethod, relPath, {
      body: body ?? undefined,
    });
  }

  // ── Read methods ───────────────────────────────────────────────────────

  public async search(
    query: string,
    filterType: string | undefined,
    pageSize: number,
  ): Promise<NotionResult<NotionSearchResponse>> {
    const body: Record<string, unknown> = { query, page_size: pageSize };
    if (filterType) body["filter"] = { property: "object", value: filterType };
    return this.request<NotionSearchResponse>(
      "POST_READ_ONLY",
      "/v1/search",
      body,
    );
  }

  public async getPage(pageId: string): Promise<NotionResult<NotionPage>> {
    return this.request<NotionPage>("GET", `/v1/pages/${pageId}`);
  }

  public async getDatabase(
    databaseId: string,
  ): Promise<NotionResult<NotionDatabase>> {
    return this.request<NotionDatabase>("GET", `/v1/databases/${databaseId}`);
  }

  public async queryDatabase(
    databaseId: string,
    filter: Record<string, unknown> | null,
    pageSize: number,
  ): Promise<NotionResult<NotionDatabaseQueryResponse>> {
    const body: Record<string, unknown> = { page_size: pageSize };
    if (filter) body["filter"] = filter;
    return this.request<NotionDatabaseQueryResponse>(
      "POST_READ_ONLY",
      `/v1/databases/${databaseId}/query`,
      body,
    );
  }

  public async listPageFileBlocks(
    pageId: string,
    pageSize = 100,
  ): Promise<NotionResult<NotionFileBlockList>> {
    const raw = await this.request<NotionBlockChildrenResponse>(
      "GET",
      `/v1/blocks/${pageId}/children?page_size=${pageSize}`,
    );
    if (!raw.ok) return raw;
    const blocks = raw.data.results ?? [];
    const results: NotionFileBlock[] = [];
    for (const b of blocks) {
      const fb = normalizeFileBlock(b);
      if (fb) results.push(fb);
    }
    return {
      ok: true,
      status: raw.status,
      data: {
        results,
        has_more: raw.data.has_more ?? false,
      },
    };
  }

  public async getBlock(
    blockId: string,
  ): Promise<NotionResult<NotionRawBlock>> {
    return this.request<NotionRawBlock>("GET", `/v1/blocks/${blockId}`);
  }

  public async getComments(
    blockId: string,
    pageSize = 100,
  ): Promise<NotionResult<NotionCommentList>> {
    const raw = await this.request<NotionRawCommentResponse>(
      "GET",
      `/v1/comments?block_id=${blockId}&page_size=${pageSize}`,
    );
    if (!raw.ok) return raw;
    const results: NotionComment[] = (raw.data.results ?? []).map((c) => ({
      id: c.id,
      author_id: c.created_by?.id ?? "",
      created: c.created_time ?? "",
      body_plain: (c.rich_text ?? [])
        .map((rt) => rt.plain_text ?? "")
        .join(""),
      parent_page_id: c.parent?.page_id ?? null,
    }));
    return {
      ok: true,
      status: raw.status,
      data: { results, has_more: raw.data.has_more ?? false },
    };
  }

  // ── Write methods ──────────────────────────────────────────────────────

  public async createPage(
    payload: Record<string, unknown>,
  ): Promise<NotionResult<NotionPage>> {
    return this.request<NotionPage>("POST", "/v1/pages", payload);
  }

  public async updatePage(
    pageId: string,
    payload: Record<string, unknown>,
  ): Promise<NotionResult<NotionPage>> {
    return this.request<NotionPage>("PATCH", `/v1/pages/${pageId}`, payload);
  }

  public async archivePage(pageId: string): Promise<NotionResult<NotionPage>> {
    return this.request<NotionPage>("PATCH", `/v1/pages/${pageId}`, {
      archived: true,
    });
  }

  public async appendBlocks(
    blockId: string,
    children: unknown[],
  ): Promise<NotionResult<NotionAppendBlocksResponse>> {
    return this.request<NotionAppendBlocksResponse>(
      "PATCH",
      `/v1/blocks/${blockId}/children`,
      { children },
    );
  }

  public async updateBlock(
    blockId: string,
    payload: Record<string, unknown>,
  ): Promise<NotionResult<NotionRawBlock>> {
    return this.request<NotionRawBlock>(
      "PATCH",
      `/v1/blocks/${blockId}`,
      payload,
    );
  }

  public async deleteBlock(
    blockId: string,
  ): Promise<NotionResult<NotionRawBlock>> {
    return this.request<NotionRawBlock>("DELETE", `/v1/blocks/${blockId}`);
  }

  public async createDatabaseEntry(
    databaseId: string,
    properties: Record<string, unknown>,
    children?: unknown[],
  ): Promise<NotionResult<NotionPage>> {
    const payload: Record<string, unknown> = {
      parent: { database_id: databaseId },
      properties,
    };
    if (children && children.length > 0) payload["children"] = children;
    return this.request<NotionPage>("POST", "/v1/pages", payload);
  }

  public async updateDatabaseEntry(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionResult<NotionPage>> {
    return this.request<NotionPage>("PATCH", `/v1/pages/${pageId}`, {
      properties,
    });
  }
}

// ── File-block normalization ───────────────────────────────────────────

export type NotionFileBlockType = "file" | "image" | "pdf" | "audio" | "video";
const FILE_BLOCK_TYPES: ReadonlySet<string> = new Set<NotionFileBlockType>([
  "file",
  "image",
  "pdf",
  "audio",
  "video",
]);

export interface NotionFileBlock {
  id: string;
  type: NotionFileBlockType;
  url_type: "file" | "external";
  url: string;
  expiry_time: string | null;
  caption: string;
  filename: string | null;
}

export interface NotionFileBlockList {
  results: NotionFileBlock[];
  has_more: boolean;
}

export interface NotionComment {
  id: string;
  author_id: string;
  created: string;
  body_plain: string;
  parent_page_id: string | null;
}

export interface NotionCommentList {
  results: NotionComment[];
  has_more: boolean;
}

interface NotionRichText {
  plain_text?: string;
}

export interface NotionRawBlock {
  id: string;
  type?: string;
  [k: string]: unknown;
}

interface NotionBlockChildrenResponse {
  results?: NotionRawBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionRawComment {
  id: string;
  created_by?: { id?: string };
  created_time?: string;
  rich_text?: NotionRichText[];
  parent?: { page_id?: string };
}

interface NotionRawCommentResponse {
  results?: NotionRawComment[];
  has_more?: boolean;
}

function normalizeFileBlock(block: NotionRawBlock): NotionFileBlock | null {
  if (typeof block.type !== "string" || !FILE_BLOCK_TYPES.has(block.type)) {
    return null;
  }
  const type = block.type as NotionFileBlockType;
  const payload = block[type];
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const urlType = p["type"];
  if (urlType !== "file" && urlType !== "external") return null;

  let url = "";
  let expiry: string | null = null;
  if (urlType === "file") {
    const f = p["file"];
    if (f && typeof f === "object") {
      const obj = f as Record<string, unknown>;
      if (typeof obj["url"] === "string") url = obj["url"];
      if (typeof obj["expiry_time"] === "string") expiry = obj["expiry_time"];
    }
  } else {
    const e = p["external"];
    if (e && typeof e === "object") {
      const obj = e as Record<string, unknown>;
      if (typeof obj["url"] === "string") url = obj["url"];
    }
  }
  if (!url) return null;

  const captionArr = Array.isArray(p["caption"]) ? p["caption"] : [];
  const caption = captionArr
    .map((rt: unknown) => {
      if (rt && typeof rt === "object") {
        const t = (rt as Record<string, unknown>)["plain_text"];
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .join("");
  const filename =
    typeof p["name"] === "string" ? (p["name"] as string) : null;

  return {
    id: block.id,
    type,
    url_type: urlType as "file" | "external",
    url,
    expiry_time: expiry,
    caption,
    filename,
  };
}

export interface NotionPage {
  id: string;
  parent?: { type?: string };
  last_edited_time?: string;
  created_time?: string;
  properties?: Record<string, unknown>;
  url?: string;
  archived?: boolean;
}

export interface NotionAppendBlocksResponse {
  results: NotionRawBlock[];
  block?: { id?: string };
}

export interface NotionDatabase {
  id: string;
  title?: Array<{ plain_text?: string }>;
  description?: Array<{ plain_text?: string }>;
  properties?: Record<string, unknown>;
  is_inline?: boolean;
}

export interface NotionSearchResponse {
  results: Array<NotionPage | NotionDatabase>;
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface NotionDatabaseQueryResponse {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export function extractTitleFromPage(page: NotionPage): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>)["type"] === "title"
    ) {
      const titleProp = value as Record<string, unknown>;
      const title = titleProp["title"];
      if (Array.isArray(title)) {
        return title
          .map((t: unknown) => {
            if (t && typeof t === "object") {
              const pt = (t as Record<string, unknown>)["plain_text"];
              return typeof pt === "string" ? pt : "";
            }
            return "";
          })
          .join("");
      }
    }
  }
  return "";
}
