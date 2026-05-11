/**
 * linear_client.ts — thin GraphQL client for Linear's API.
 *
 * Design:
 * - Single endpoint: POST https://api.linear.app/graphql
 * - Auth: `Authorization: <api_key>` (no Bearer — Linear-specific)
 * - Retry/rate-limit/timeout pattern mirrors jira_client.ts
 * - Best-effort 60-req/min ceiling per instance
 * - Exponential backoff honours Retry-After on 429/5xx
 * - Connect/read timeouts via AbortController (10s / 30s)
 */
import { resolveSecret } from "narai-primitives/credentials";
import {
  GET_ISSUE,
  SEARCH_ISSUES,
  GET_PROJECT,
  GET_TEAM,
  TEAMS_BY_KEY,
  GET_COMMENTS,
  LIST_ATTACHMENTS,
  CREATE_ISSUE,
  UPDATE_ISSUE,
  ARCHIVE_ISSUE,
  ADD_COMMENT,
  UPDATE_COMMENT,
  DELETE_COMMENT,
  ATTACHMENT_LINK,
} from "./queries.js";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_PER_MIN = 60;
const MAX_ATTEMPTS = 4;

export interface LinearClientOptions {
  apiKey: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface LinearErrorPayload {
  ok: false;
  code: string;
  message: string;
  retriable: boolean;
  status?: number;
}

export interface LinearSuccessPayload<T> {
  ok: true;
  data: T;
  status: number;
}

export type LinearResult<T> = LinearSuccessPayload<T> | LinearErrorPayload;

/** Resolve Linear credentials from the shared credential provider chain. */
export async function loadLinearCredentials(): Promise<
  { apiKey: string } | null
> {
  const apiKey =
    (await resolveSecret("LINEAR_API_KEY")) ??
    process.env["LINEAR_API_KEY"] ??
    null;
  if (!apiKey) return null;
  return { apiKey };
}

export class LinearClient {
  private readonly _authHeader: string;
  private readonly _rateLimitPerMin: number;
  private readonly _connectTimeoutMs: number;
  private readonly _readTimeoutMs: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _sleep: (ms: number) => Promise<void>;
  private _requestTimestamps: number[] = [];

  constructor(opts: LinearClientOptions) {
    this._authHeader = opts.apiKey;
    this._rateLimitPerMin = opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this._fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._sleep =
      opts.sleepImpl ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Reset the request-per-minute sliding window (test helper). */
  public resetRateLimiter(): void {
    this._requestTimestamps = [];
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

  /**
   * Execute a GraphQL query or mutation against Linear's API.
   * Returns LinearResult<T> where T is the shape of `data` in the response.
   */
  public async query<T = unknown>(
    doc: string,
    variables?: Record<string, unknown>,
  ): Promise<LinearResult<T>> {
    const body = JSON.stringify({ query: doc, variables: variables ?? {} });

    let lastError: LinearErrorPayload | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await this._throttle();
      const connectCtrl = new AbortController();
      const readCtrl = new AbortController();
      const connectTimer = setTimeout(
        () => connectCtrl.abort(),
        this._connectTimeoutMs,
      );
      const readTimer = setTimeout(
        () => readCtrl.abort(),
        this._connectTimeoutMs + this._readTimeoutMs,
      );
      try {
        const response = await this._fetch(LINEAR_GRAPHQL_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: this._authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.any([connectCtrl.signal, readCtrl.signal]),
        });
        clearTimeout(connectTimer);
        const status = response.status;

        if (status === 429 || status >= 500) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          const backoff = retryAfter ?? Math.min(30_000, 500 * 2 ** attempt);
          lastError = {
            ok: false,
            code: status === 429 ? "RATE_LIMITED" : "SERVER_ERROR",
            message: `Linear returned HTTP ${status}`,
            retriable: true,
            status,
          };
          if (attempt < MAX_ATTEMPTS - 1) {
            await this._sleep(backoff);
            continue;
          }
          return lastError;
        }

        if (!response.ok) {
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            /* ignore */
          }
          return {
            ok: false,
            code: classifyHttpStatus(status),
            message: `Linear HTTP ${status}: ${truncate(bodyText, 200)}`,
            retriable: false,
            status,
          };
        }

        // Parse GraphQL response
        const json = (await response.json()) as {
          data?: T;
          errors?: Array<{ message: string; extensions?: { code?: string } }>;
        };

        if (json.errors && json.errors.length > 0) {
          const first = json.errors[0]!;
          const code = first.extensions?.code ?? "GRAPHQL_ERROR";
          return {
            ok: false,
            code,
            message: first.message,
            retriable: false,
            status,
          };
        }

        if (!json.data) {
          return {
            ok: false,
            code: "GRAPHQL_ERROR",
            message: "Linear response contained no data",
            retriable: false,
            status,
          };
        }

        return { ok: true, data: json.data, status };
      } catch (err) {
        clearTimeout(connectTimer);
        const message = err instanceof Error ? err.message : String(err);
        const aborted =
          err instanceof DOMException || /abort/i.test(message);
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

  // ── Typed operation methods ──────────────────────────────────────────────

  public async getIssue(idOrIdentifier: string): Promise<LinearResult<{ issue: LinearIssue }>> {
    return this.query<{ issue: LinearIssue }>(GET_ISSUE, { id: idOrIdentifier });
  }

  public async searchIssues(filter: {
    team_key?: string;
    state?: string;
    assignee_email?: string;
    text?: string;
    max_results: number;
  }): Promise<LinearResult<{ issues: { nodes: LinearIssueSummary[]; pageInfo: { hasNextPage: boolean } } }>> {
    const gqlFilter: Record<string, unknown> = {};
    if (filter.team_key) {
      gqlFilter["team"] = { key: { eq: filter.team_key } };
    }
    if (filter.state) {
      gqlFilter["state"] = { name: { eq: filter.state } };
    }
    if (filter.assignee_email) {
      gqlFilter["assignee"] = { email: { eq: filter.assignee_email } };
    }
    if (filter.text) {
      gqlFilter["title"] = { containsIgnoreCase: filter.text };
    }
    return this.query(SEARCH_ISSUES, {
      filter: Object.keys(gqlFilter).length > 0 ? gqlFilter : undefined,
      first: filter.max_results,
    });
  }

  public async getProject(id: string): Promise<LinearResult<{ project: LinearProject }>> {
    return this.query<{ project: LinearProject }>(GET_PROJECT, { id });
  }

  public async getTeam(keyOrId: string): Promise<LinearResult<{ team: LinearTeam }>> {
    // Try as UUID first (36-char or 32-char hex), otherwise use key search
    const isUuid = /^[0-9a-fA-F-]{32,}$/.test(keyOrId);
    if (isUuid) {
      return this.query<{ team: LinearTeam }>(GET_TEAM, { id: keyOrId });
    }
    // Search by key
    const r = await this.query<{ teams: { nodes: LinearTeam[] } }>(TEAMS_BY_KEY, { key: keyOrId });
    if (!r.ok) return r;
    const team = r.data.teams.nodes[0];
    if (!team) {
      return { ok: false, code: "NOT_FOUND", message: `Team with key '${keyOrId}' not found`, retriable: false };
    }
    return { ok: true, data: { team }, status: r.status };
  }

  public async getComments(issueId: string, maxResults: number): Promise<LinearResult<{ issue: { comments: { nodes: LinearComment[]; pageInfo: { hasNextPage: boolean } } } | null }>> {
    return this.query(GET_COMMENTS, { id: issueId, first: maxResults });
  }

  public async listAttachments(issueId: string): Promise<LinearResult<{ issue: { attachments: { nodes: LinearAttachment[] } } | null }>> {
    return this.query(LIST_ATTACHMENTS, { id: issueId });
  }

  public async createIssue(input: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
    labelIds?: string[];
    priority?: number;
    parentId?: string;
  }): Promise<LinearResult<{ issueCreate: { success: boolean; issue: LinearIssueSummary } }>> {
    return this.query(CREATE_ISSUE, { input });
  }

  public async updateIssue(id: string, input: {
    title?: string;
    description?: string;
    assigneeId?: string;
    stateId?: string;
    priority?: number;
  }): Promise<LinearResult<{ issueUpdate: { success: boolean; issue: { id: string; identifier: string; updatedAt: string } } }>> {
    return this.query(UPDATE_ISSUE, { id, input });
  }

  public async archiveIssue(id: string): Promise<LinearResult<{ issueArchive: { success: boolean } }>> {
    return this.query(ARCHIVE_ISSUE, { id });
  }

  public async addComment(input: {
    issueId: string;
    body: string;
  }): Promise<LinearResult<{ commentCreate: { success: boolean; comment: LinearComment } }>> {
    return this.query(ADD_COMMENT, { input });
  }

  public async updateComment(id: string, input: { body: string }): Promise<LinearResult<{ commentUpdate: { success: boolean; comment: { id: string; body: string; updatedAt: string } } }>> {
    return this.query(UPDATE_COMMENT, { id, input });
  }

  public async deleteComment(id: string): Promise<LinearResult<{ commentDelete: { success: boolean } }>> {
    return this.query(DELETE_COMMENT, { id });
  }

  public async attachmentLink(input: {
    issueId: string;
    title: string;
    url: string;
    subtitle?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LinearResult<{ attachmentCreate: { success: boolean; attachment: { id: string; title: string; url: string; createdAt: string } } }>> {
    return this.query(ATTACHMENT_LINK, { input });
  }
}

// ── Response types (partial; only fields we surface) ──────────────────

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  state: { id: string; name: string; type: string } | null;
  assignee: { id: string; name: string; email: string; displayName: string } | null;
  team: { id: string; key: string; name: string } | null;
  labels: { nodes: Array<{ id: string; name: string; color: string }> };
}

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { displayName: string; email: string } | null;
  team: { key: string; name: string } | null;
}

export interface LinearProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; displayName: string; email: string } | null;
}

export interface LinearAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  createdAt: string;
  creator: { displayName: string } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────

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
