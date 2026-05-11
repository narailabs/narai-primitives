/**
 * github_client.ts — GitHub REST + GraphQL client. Supports read +
 * write/admin operations; gating is enforced by the toolkit policy
 * layer at the connector boundary, not by the HTTP surface itself.
 *
 * Thin wrapper over the shared `HttpClient` in `narai-primitives/toolkit`:
 * supplies Bearer auth + GitHub's API-version + Accept headers, surfaces
 * GitHub's primary-rate-limit signal (`x-ratelimit-remaining: 0` on a 403
 * — usually a rate-limit in disguise), and exposes both REST GETs and
 * POSTs against `/graphql`.
 */
import {
  HttpClient,
  type BinaryResponse,
  type HttpResult,
  type HttpResultErr,
  type HttpResultOk,
} from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GithubClientOptions {
  token: string;
  apiBase?: string;
  defaultOwner?: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type GithubErrorPayload = HttpResultErr;
export type GithubSuccessPayload<T> = HttpResultOk<T>;
export type GithubResult<T> = HttpResult<T>;

export async function loadGithubCredentials(): Promise<
  { token: string; defaultOwner: string | null } | null
> {
  const token =
    (await resolveSecret("GITHUB_TOKEN")) ??
    process.env["GITHUB_TOKEN"] ??
    null;
  if (!token) return null;
  const defaultOwner =
    (await resolveSecret("GITHUB_OWNER")) ??
    process.env["GITHUB_OWNER"] ??
    null;
  return { token, defaultOwner };
}

export class GithubClient {
  private readonly _http: HttpClient;
  private _defaultOwner: string | null = null;

  constructor(opts: GithubClientOptions) {
    const apiBase = opts.apiBase ?? GITHUB_API_BASE;
    this._defaultOwner = opts.defaultOwner ?? null;
    this._http = new HttpClient({
      baseUrl: apiBase,
      authHeader: `Bearer ${opts.token}`,
      serviceName: "GitHub",
      allowedMethods: new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]),
      defaultHeaders: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      rateLimitPerMin: opts.rateLimitPerMin,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      // GitHub's primary rate limit surfaces as 403 + `x-ratelimit-remaining: 0`.
      // The shared client treats this as a 429 (retry with backoff).
      shouldRetryResponse: (r) =>
        r.status === 403 &&
        r.headers.get("x-ratelimit-remaining") === "0",
    });
  }

  public get defaultOwner(): string | null {
    return this._defaultOwner;
  }

  public get host(): string {
    return this._http.host;
  }

  public async get<T = unknown>(
    relPath: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<GithubResult<T>> {
    return this._http.request<T>("GET", relPath, { query });
  }

  public async graphql<T = unknown>(
    queryDoc: string,
    variables: Record<string, unknown> = {},
  ): Promise<GithubResult<T>> {
    return this._http.request<T>("POST", "/graphql", {
      body: { query: queryDoc, variables },
    });
  }

  public async getRepo(
    owner: string,
    repo: string,
  ): Promise<GithubResult<GithubRepo>> {
    return this.get<GithubRepo>(`/repos/${owner}/${repo}`);
  }

  public async listIssues(
    owner: string,
    repo: string,
    opts: {
      state?: string;
      labels?: string[];
      perPage?: number;
      page?: number;
    } = {},
  ): Promise<GithubResult<GithubIssue[]>> {
    return this.get<GithubIssue[]>(`/repos/${owner}/${repo}/issues`, {
      state: opts.state ?? "open",
      labels: opts.labels?.join(",") ?? undefined,
      per_page: opts.perPage ?? 30,
      page: opts.page,
    });
  }

  public async listPulls(
    owner: string,
    repo: string,
    opts: { state?: string; perPage?: number; page?: number } = {},
  ): Promise<GithubResult<GithubPull[]>> {
    return this.get<GithubPull[]>(`/repos/${owner}/${repo}/pulls`, {
      state: opts.state ?? "open",
      per_page: opts.perPage ?? 30,
      page: opts.page,
    });
  }

  public async getFile(
    owner: string,
    repo: string,
    filePath: string,
    ref = "main",
  ): Promise<GithubResult<GithubContent>> {
    return this.get<GithubContent>(
      `/repos/${owner}/${repo}/contents/${filePath}`,
      { ref },
    );
  }

  public async searchCode(
    owner: string,
    repo: string,
    query: string,
    perPage = 30,
  ): Promise<GithubResult<GithubSearchCodeResponse>> {
    const q = `${query} repo:${owner}/${repo}`;
    return this.get<GithubSearchCodeResponse>("/search/code", {
      q,
      per_page: perPage,
    });
  }

  public async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    perPage = 100,
  ): Promise<GithubResult<GithubIssueCommentList>> {
    const raw = await this.get<GithubRawIssueComment[]>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { per_page: perPage },
    );
    if (!raw.ok) return raw;
    const results: GithubIssueComment[] = (raw.data ?? []).map((c) => ({
      id: c.id,
      author: c.user?.login ?? "",
      created_at: c.created_at ?? "",
      updated_at: c.updated_at ?? c.created_at ?? "",
      body_markdown: c.body ?? "",
      html_url: c.html_url ?? "",
    }));
    return { ok: true, status: raw.status, data: { issueNumber, results } };
  }

  public async getPullReviews(
    owner: string,
    repo: string,
    prNumber: number,
    perPage = 100,
  ): Promise<GithubResult<GithubPullReview[]>> {
    const raw = await this.get<GithubRawPullReview[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      { per_page: perPage },
    );
    if (!raw.ok) return raw;
    const results: GithubPullReview[] = (raw.data ?? []).map((r) => ({
      id: r.id,
      author: r.user?.login ?? "",
      state: r.state ?? "",
      submitted_at: r.submitted_at ?? "",
      body_markdown: r.body ?? "",
      html_url: r.html_url ?? "",
    }));
    return { ok: true, status: raw.status, data: results };
  }

  public async getPullReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    perPage = 100,
  ): Promise<GithubResult<GithubPullInlineComment[]>> {
    const raw = await this.get<GithubRawPullReviewComment[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      { per_page: perPage },
    );
    if (!raw.ok) return raw;
    const results: GithubPullInlineComment[] = (raw.data ?? []).map((c) => ({
      id: c.id,
      author: c.user?.login ?? "",
      path: c.path ?? "",
      line: c.line ?? c.original_line ?? null,
      commit_id: c.commit_id ?? "",
      created_at: c.created_at ?? "",
      updated_at: c.updated_at ?? c.created_at ?? "",
      body_markdown: c.body ?? "",
      html_url: c.html_url ?? "",
      diff_hunk: c.diff_hunk ?? "",
    }));
    return { ok: true, status: raw.status, data: results };
  }

  public async listReleaseByTag(
    owner: string,
    repo: string,
    tag: string,
  ): Promise<GithubResult<GithubReleaseWithAssets>> {
    return this.get<GithubReleaseWithAssets>(
      `/repos/${owner}/${repo}/releases/tags/${tag}`,
    );
  }

  public async getReleaseAssetDownload(
    owner: string,
    repo: string,
    assetId: number,
  ): Promise<GithubResult<BinaryResponse>> {
    return this._http.request<BinaryResponse>(
      "GET",
      `/repos/${owner}/${repo}/releases/assets/${assetId}`,
      {
        responseType: "binary",
        headers: { Accept: "application/octet-stream" },
        filenameFallback: `asset-${assetId}`,
      },
    );
  }

  // ─── pull requests ──────────────────────────────────────────────────────
  public async getPull(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
    );
  }

  public async createPull(
    owner: string,
    repo: string,
    body: {
      title: string;
      head: string;
      base: string;
      body?: string;
      draft?: boolean;
      maintainer_can_modify?: boolean;
    },
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      { body },
    );
  }

  public async updatePull(
    owner: string,
    repo: string,
    pullNumber: number,
    body: {
      title?: string;
      body?: string;
      state?: "open";
      base?: string;
      maintainer_can_modify?: boolean;
    },
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
      { body },
    );
  }

  public async closePull(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GithubResult<GithubPullDetail>> {
    return this._http.request<GithubPullDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
      { body: { state: "closed" } },
    );
  }

  public async mergePull(
    owner: string,
    repo: string,
    pullNumber: number,
    body: {
      commit_title?: string;
      commit_message?: string;
      sha?: string;
      merge_method: "merge" | "squash" | "rebase";
    },
  ): Promise<GithubResult<{ sha: string; merged: boolean; message: string }>> {
    return this._http.request(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      { body },
    );
  }

  // ─── issues ─────────────────────────────────────────────────────────────
  public async getIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GithubResult<GithubIssueDetail>> {
    return this._http.request<GithubIssueDetail>(
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
    );
  }

  public async createIssue(
    owner: string,
    repo: string,
    body: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      milestone?: number;
    },
  ): Promise<GithubResult<GithubIssueDetail>> {
    return this._http.request<GithubIssueDetail>(
      "POST",
      `/repos/${owner}/${repo}/issues`,
      { body },
    );
  }

  public async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body: {
      title?: string;
      body?: string;
      state?: "open";
      labels?: string[];
      assignees?: string[];
      milestone?: number | null;
    },
  ): Promise<GithubResult<GithubIssueDetail>> {
    return this._http.request<GithubIssueDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      { body },
    );
  }

  public async closeIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body?: { state_reason?: "completed" | "not_planned" | "reopened" | null },
  ): Promise<GithubResult<GithubIssueDetail>> {
    const payload: { state: "closed"; state_reason?: string | null } = {
      state: "closed",
    };
    if (body?.state_reason !== undefined)
      payload.state_reason = body.state_reason;
    return this._http.request<GithubIssueDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      { body: payload },
    );
  }

  /** List wiki pages via GraphQL (repository has hasWikiEnabled flag). */
  public async listWikiPages(
    owner: string,
    repo: string,
  ): Promise<GithubResult<{ hasWikiEnabled: boolean }>> {
    const query = `
      query WikiPages($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          hasWikiEnabled
        }
      }
    `;
    const res = await this.graphql<{
      data?: { repository?: { hasWikiEnabled: boolean } };
    }>(query, { owner, repo });
    if (!res.ok) return res;
    const enabled = res.data?.data?.repository?.hasWikiEnabled ?? false;
    return { ok: true, data: { hasWikiEnabled: enabled }, status: res.status };
  }

  // ─── comments — issue-conversation ──────────────────────────────────────
  public async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: { body: string },
  ): Promise<GithubResult<GithubRawIssueComment>> {
    return this._http.request<GithubRawIssueComment>(
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  public async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: { body: string },
  ): Promise<GithubResult<GithubRawIssueComment>> {
    return this._http.request<GithubRawIssueComment>(
      "PATCH",
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { body },
    );
  }

  public async deleteIssueComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    );
  }

  // ─── comments — PR review-inline ────────────────────────────────────────
  public async addPrReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: {
      body: string;
      commit_id: string;
      path: string;
      line: number;
      side?: "LEFT" | "RIGHT";
      start_line?: number;
      start_side?: "LEFT" | "RIGHT";
    },
  ): Promise<GithubResult<GithubRawPullReviewComment>> {
    return this._http.request<GithubRawPullReviewComment>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      { body },
    );
  }

  public async updatePrReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    body: { body: string },
  ): Promise<GithubResult<GithubRawPullReviewComment>> {
    return this._http.request<GithubRawPullReviewComment>(
      "PATCH",
      `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
      { body },
    );
  }

  public async deletePrReviewComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/pulls/comments/${commentId}`,
    );
  }

  // ─── releases (mutations) ───────────────────────────────────────────────
  public async createRelease(
    owner: string,
    repo: string,
    body: {
      tag_name: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
      make_latest?: "true" | "false" | "legacy";
    },
  ): Promise<GithubResult<GithubReleaseDetail>> {
    return this._http.request<GithubReleaseDetail>(
      "POST",
      `/repos/${owner}/${repo}/releases`,
      { body },
    );
  }

  public async updateRelease(
    owner: string,
    repo: string,
    releaseId: number,
    body: {
      tag_name?: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
    },
  ): Promise<GithubResult<GithubReleaseDetail>> {
    return this._http.request<GithubReleaseDetail>(
      "PATCH",
      `/repos/${owner}/${repo}/releases/${releaseId}`,
      { body },
    );
  }

  public async deleteRelease(
    owner: string,
    repo: string,
    releaseId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/releases/${releaseId}`,
    );
  }

  public async deleteReleaseAsset(
    owner: string,
    repo: string,
    assetId: number,
  ): Promise<GithubResult<unknown>> {
    return this._http.request<unknown>(
      "DELETE",
      `/repos/${owner}/${repo}/releases/assets/${assetId}`,
    );
  }
}

// ── Response types (partial; only fields we surface) ──────────────────

export interface GithubRepo {
  full_name: string;
  description?: string | null;
  default_branch?: string;
  language?: string | null;
  stargazers_count?: number;
  open_issues_count?: number;
  topics?: string[];
  updated_at?: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name?: string } | string>;
  user?: { login?: string };
  html_url?: string;
  updated_at?: string;
}

export interface GithubIssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  user?: { login: string };
  labels?: Array<string | { name?: string }>;
  html_url?: string;
  body?: string;
  updated_at?: string;
  state_reason?: string | null;
  assignees?: Array<{ login: string }>;
}

export interface GithubPull {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  html_url?: string;
  updated_at?: string;
}

export interface GithubPullDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  user?: { login: string };
  base?: { ref: string; sha: string };
  head?: { ref: string; sha: string };
  html_url?: string;
  body?: string;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  updated_at?: string;
}

export interface GithubContent {
  path: string;
  size: number;
  content?: string;
  encoding?: string;
  sha?: string;
}

export interface GithubSearchCodeResponse {
  total_count: number;
  items: Array<{
    path: string;
    repository: { full_name: string };
    html_url: string;
  }>;
}

export interface GithubIssueComment {
  id: number;
  author: string;
  created_at: string;
  updated_at: string;
  body_markdown: string;
  html_url: string;
}

export interface GithubIssueCommentList {
  issueNumber: number;
  results: GithubIssueComment[];
}

export interface GithubRawIssueComment {
  id: number;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  body?: string;
  html_url?: string;
}

export interface GithubPullReview {
  id: number;
  author: string;
  state: string;
  submitted_at: string;
  body_markdown: string;
  html_url: string;
}

interface GithubRawPullReview {
  id: number;
  user?: { login?: string };
  state?: string;
  submitted_at?: string;
  body?: string;
  html_url?: string;
}

export interface GithubPullInlineComment {
  id: number;
  author: string;
  path: string;
  line: number | null;
  commit_id: string;
  created_at: string;
  updated_at: string;
  body_markdown: string;
  html_url: string;
  diff_hunk: string;
}

export interface GithubRawPullReviewComment {
  id: number;
  user?: { login?: string };
  path?: string;
  line?: number | null;
  original_line?: number | null;
  commit_id?: string;
  created_at?: string;
  updated_at?: string;
  body?: string;
  html_url?: string;
  diff_hunk?: string;
}

export interface GithubReleaseAsset {
  id: number;
  name: string;
  label?: string | null;
  content_type: string;
  size: number;
  download_count: number;
  created_at: string;
  updated_at: string;
  browser_download_url: string;
}

export interface GithubReleaseWithAssets {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  created_at?: string;
  published_at?: string;
  author?: { login?: string };
  assets: GithubReleaseAsset[];
}

export interface GithubReleaseDetail {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string | null;
  target_commitish?: string;
}
