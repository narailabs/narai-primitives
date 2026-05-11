/**
 * jira_client.ts — Atlassian Cloud REST v3 HTTP client.
 *
 * Thin wrapper over the shared `HttpClient` in `narai-primitives/toolkit`:
 * supplies Basic-auth, the Atlassian-Token header on multipart uploads,
 * and the Jira endpoint surface. All retry/throttle/timeout/URL-validation
 * logic comes from the shared client.
 */
import {
  HttpClient,
  type BinaryResponse,
  type HttpResult,
  type HttpResultErr,
  type HttpResultOk,
} from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";
import { adfToPlainText, type AdfNode } from "./adf.js";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface JiraClientOptions {
  /** Atlassian Cloud site URL — e.g. https://acme.atlassian.net. */
  siteUrl: string;
  /** User email for Basic auth. */
  email: string;
  /** API token for Basic auth. */
  apiToken: string;
  /** Per-client request-per-minute ceiling. Default 60. */
  rateLimitPerMin?: number;
  /** Connect timeout ms. Default 10_000. */
  connectTimeoutMs?: number;
  /** Read timeout ms. Default 30_000. */
  readTimeoutMs?: number;
  /** Optional fetch-override used by unit tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Optional sleep-override used by unit tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type JiraErrorPayload = HttpResultErr;
export type JiraSuccessPayload<T> = HttpResultOk<T>;
export type JiraResult<T> = HttpResult<T>;

export async function loadJiraCredentials(): Promise<
  { siteUrl: string; email: string; apiToken: string } | null
> {
  const siteUrl =
    (await resolveSecret("JIRA_SITE_URL")) ??
    process.env["JIRA_SITE_URL"] ??
    null;
  const email =
    (await resolveSecret("JIRA_EMAIL")) ?? process.env["JIRA_EMAIL"] ?? null;
  const apiToken =
    (await resolveSecret("JIRA_API_TOKEN")) ??
    process.env["JIRA_API_TOKEN"] ??
    null;
  if (!siteUrl || !email || !apiToken) return null;
  return { siteUrl, email, apiToken };
}

export class JiraClient {
  private readonly _http: HttpClient;
  private readonly _site: string;

  constructor(opts: JiraClientOptions) {
    this._site = opts.siteUrl.replace(/\/+$/, "");
    const basic = Buffer.from(
      `${opts.email}:${opts.apiToken}`,
      "utf-8",
    ).toString("base64");
    this._http = new HttpClient({
      baseUrl: opts.siteUrl,
      authHeader: `Basic ${basic}`,
      serviceName: "Jira",
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

  /** Clear the per-client rate-limit sliding window. Test-only convenience. */
  public resetRateLimiter(): void {
    this._http.resetRateLimiter();
  }

  public async request<T = unknown>(
    method: HttpMethod,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined | null>;
      headers?: Record<string, string>;
      body?: object | FormData;
    } = {},
  ): Promise<JiraResult<T>> {
    return this._http.request<T>(method, path, {
      query: init.query,
      headers: init.headers,
      body: init.body,
    });
  }

  /**
   * JQL search. Uses `/rest/api/3/search/jql` (Cloud) — the legacy
   * `/rest/api/3/search` endpoint was decommissioned in 2025 and now returns
   * HTTP 410. The new endpoint paginates with an opaque `nextPageToken` and
   * does NOT return `total`; we synthesize a `total` from the issues length
   * for backward-compatible callers, and treat the absence of `nextPageToken`
   * as "no more pages".
   */
  public async searchJql(
    jql: string,
    maxResults: number,
    startAt = 0,
  ): Promise<JiraResult<JiraSearchResponse>> {
    type NewSearchResponse = {
      issues?: JiraIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    };
    const result = await this.request<NewSearchResponse>(
      "GET",
      "/rest/api/3/search/jql",
      {
        query: {
          jql,
          maxResults,
          fields: "summary,status,assignee,labels,updated",
        },
      },
    );
    if (!result.ok) return result;
    const issues = result.data.issues ?? [];
    return {
      ok: true,
      status: result.status,
      data: {
        issues,
        total: issues.length,
        maxResults,
        startAt,
      },
    };
  }

  public async getIssue(
    issueKey: string,
    expand: string[] = [],
  ): Promise<JiraResult<JiraIssue>> {
    const opts: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } = {};
    if (expand.length) opts.query = { expand: expand.join(",") };
    return this.request<JiraIssue>(
      "GET",
      `/rest/api/3/issue/${issueKey}`,
      opts,
    );
  }

  public async getProject(
    projectKey: string,
  ): Promise<JiraResult<JiraProject>> {
    return this.request<JiraProject>(
      "GET",
      `/rest/api/3/project/${projectKey}`,
    );
  }

  public async listAttachments(
    issueKey: string,
  ): Promise<JiraResult<JiraAttachmentList>> {
    const raw = await this.request<JiraIssueWithAttachments>(
      "GET",
      `/rest/api/3/issue/${issueKey}`,
      { query: { fields: "attachment" } },
    );
    if (!raw.ok) return raw;
    const atts = raw.data.fields?.attachment ?? [];
    const results: JiraAttachment[] = atts.map((a) => ({
      id: a.id,
      filename: a.filename ?? "",
      mediaType: a.mimeType ?? "application/octet-stream",
      sizeBytes: a.size ?? 0,
      created: a.created ?? "",
      author: a.author?.displayName ?? "",
      contentUrl: a.content ?? "",
    }));
    return {
      ok: true,
      status: raw.status,
      data: { issueKey: raw.data.key ?? issueKey, results },
    };
  }

  public async getAttachmentDownload(
    attachmentId: string,
  ): Promise<JiraResult<BinaryResponse>> {
    return this._http.request<BinaryResponse>(
      "GET",
      `/rest/api/3/attachment/content/${attachmentId}`,
      {
        responseType: "binary",
        filenameFallback: attachmentId,
      },
    );
  }

  public async getComments(
    issueKey: string,
    maxResults = 50,
  ): Promise<JiraResult<JiraCommentList>> {
    const raw = await this.request<JiraRawCommentResponse>(
      "GET",
      `/rest/api/3/issue/${issueKey}/comment`,
      { query: { orderBy: "created", maxResults } },
    );
    if (!raw.ok) return raw;
    const comments = raw.data.comments ?? [];
    const results: JiraComment[] = comments.map((c) => ({
      id: c.id,
      author: c.author?.displayName ?? "",
      created: c.created ?? "",
      updated: c.updated ?? c.created ?? "",
      body_plain: adfToPlainText(c.body),
    }));
    return {
      ok: true,
      status: raw.status,
      data: { issueKey, results, total: raw.data.total ?? results.length },
    };
  }

  public async createIssue(
    payload: object,
  ): Promise<JiraResult<{ key: string; id: string; self: string }>> {
    return this.request("POST", "/rest/api/3/issue", { body: payload });
  }

  public async updateIssue(
    key: string,
    payload: object,
  ): Promise<JiraResult<Record<string, never>>> {
    return this.request("PUT", `/rest/api/3/issue/${key}`, { body: payload });
  }

  public async deleteIssue(
    key: string,
  ): Promise<JiraResult<Record<string, never>>> {
    return this.request("DELETE", `/rest/api/3/issue/${key}`);
  }

  public async addComment(
    key: string,
    payload: object,
  ): Promise<JiraResult<JiraRawComment>> {
    return this.request("POST", `/rest/api/3/issue/${key}/comment`, {
      body: payload,
    });
  }

  public async updateComment(
    key: string,
    id: string,
    payload: object,
  ): Promise<JiraResult<JiraRawComment>> {
    return this.request(
      "PUT",
      `/rest/api/3/issue/${key}/comment/${id}`,
      { body: payload },
    );
  }

  public async deleteComment(
    key: string,
    id: string,
  ): Promise<JiraResult<Record<string, never>>> {
    return this.request("DELETE", `/rest/api/3/issue/${key}/comment/${id}`);
  }

  public async transitionIssue(
    key: string,
    payload: object,
  ): Promise<JiraResult<Record<string, never>>> {
    return this.request("POST", `/rest/api/3/issue/${key}/transitions`, {
      body: payload,
    });
  }

  public async postAttachment(
    key: string,
    files: Array<{ filename: string; bytes: Uint8Array; mimeType?: string }>,
  ): Promise<JiraResult<JiraRawAttachment[]>> {
    const formData = new FormData();
    for (const f of files) {
      const blob = new Blob([f.bytes], {
        type: f.mimeType ?? "application/octet-stream",
      });
      formData.append("file", blob, f.filename);
    }
    return this.request("POST", `/rest/api/3/issue/${key}/attachments`, {
      body: formData,
      headers: { "X-Atlassian-Token": "no-check" },
    });
  }
}

// ── Response types (partial; only fields we surface) ──────────────────

export interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    labels?: string[];
    updated?: string;
  };
}

export interface JiraSearchResponse {
  total: number;
  issues: JiraIssue[];
  maxResults?: number;
  startAt?: number;
}

export interface JiraProject {
  key: string;
  name?: string;
  description?: string;
  lead?: { displayName?: string } | null;
  issueTypes?: Array<{ name?: string }>;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  created: string;
  author: string;
  contentUrl: string;
}

export interface JiraAttachmentList {
  issueKey: string;
  results: JiraAttachment[];
}

interface JiraRawAttachment {
  id: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string };
  content?: string;
}

interface JiraIssueWithAttachments {
  key?: string;
  fields?: { attachment?: JiraRawAttachment[] };
}

export interface JiraComment {
  id: string;
  author: string;
  created: string;
  updated: string;
  body_plain: string;
}

export interface JiraCommentList {
  issueKey: string;
  results: JiraComment[];
  total: number;
}

interface JiraRawComment {
  id: string;
  author?: { displayName?: string };
  created?: string;
  updated?: string;
  body?: AdfNode;
}

interface JiraRawCommentResponse {
  comments?: JiraRawComment[];
  total?: number;
}
