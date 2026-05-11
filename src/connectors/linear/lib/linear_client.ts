/**
 * linear_client.ts — thin GraphQL client for Linear's API.
 *
 * Thin wrapper over the shared `HttpClient` in `narai-primitives/toolkit`:
 * adds the Linear-specific raw-key Authorization header (no Bearer prefix),
 * POSTs every operation to `/graphql`, and unwraps the `{data, errors}`
 * GraphQL response envelope. All retry/throttle/timeout/URL-validation
 * logic comes from the shared client.
 */
import {
  HttpClient,
  type HttpResult,
  type HttpResultErr,
  type HttpResultOk,
} from "narai-primitives/toolkit";
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

const LINEAR_API_BASE = "https://api.linear.app";
const LINEAR_GRAPHQL_PATH = "/graphql";

export interface LinearClientOptions {
  apiKey: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type LinearErrorPayload = HttpResultErr;
export type LinearSuccessPayload<T> = HttpResultOk<T>;
export type LinearResult<T> = HttpResult<T>;

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
  private readonly _http: HttpClient;

  constructor(opts: LinearClientOptions) {
    this._http = new HttpClient({
      baseUrl: LINEAR_API_BASE,
      // Linear uses the raw API key as the Authorization header value —
      // no `Bearer ` prefix.
      authHeader: opts.apiKey,
      serviceName: "Linear",
      allowedMethods: new Set(["POST"]),
      rateLimitPerMin: opts.rateLimitPerMin,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    });
  }

  /** Clear the per-client rate-limit sliding window. Test-only convenience. */
  public resetRateLimiter(): void {
    this._http.resetRateLimiter();
  }

  /**
   * Execute a GraphQL query or mutation against Linear's API.
   * Returns `LinearResult<T>` where `T` is the shape of `data` in the
   * response. GraphQL `errors` are surfaced as `ok: false` results.
   */
  public async query<T = unknown>(
    doc: string,
    variables?: Record<string, unknown>,
  ): Promise<LinearResult<T>> {
    const raw = await this._http.request<{
      data?: T;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    }>("POST", LINEAR_GRAPHQL_PATH, {
      body: { query: doc, variables: variables ?? {} },
    });
    if (!raw.ok) return raw;
    const json = raw.data;
    if (json.errors && json.errors.length > 0) {
      const first = json.errors[0]!;
      const code = first.extensions?.code ?? "GRAPHQL_ERROR";
      return {
        ok: false,
        code,
        message: first.message,
        retriable: false,
        status: raw.status,
      };
    }
    if (!json.data) {
      return {
        ok: false,
        code: "GRAPHQL_ERROR",
        message: "Linear response contained no data",
        retriable: false,
        status: raw.status,
      };
    }
    return { ok: true, data: json.data, status: raw.status };
  }

  // ── Typed operation methods ──────────────────────────────────────────────

  public async getIssue(
    idOrIdentifier: string,
  ): Promise<LinearResult<{ issue: LinearIssue }>> {
    return this.query<{ issue: LinearIssue }>(GET_ISSUE, {
      id: idOrIdentifier,
    });
  }

  public async searchIssues(filter: {
    team_key?: string;
    state?: string;
    assignee_email?: string;
    text?: string;
    max_results: number;
  }): Promise<
    LinearResult<{
      issues: {
        nodes: LinearIssueSummary[];
        pageInfo: { hasNextPage: boolean };
      };
    }>
  > {
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

  public async getProject(
    id: string,
  ): Promise<LinearResult<{ project: LinearProject }>> {
    return this.query<{ project: LinearProject }>(GET_PROJECT, { id });
  }

  public async getTeam(
    keyOrId: string,
  ): Promise<LinearResult<{ team: LinearTeam }>> {
    const isUuid = /^[0-9a-fA-F-]{32,}$/.test(keyOrId);
    if (isUuid) {
      return this.query<{ team: LinearTeam }>(GET_TEAM, { id: keyOrId });
    }
    const r = await this.query<{ teams: { nodes: LinearTeam[] } }>(
      TEAMS_BY_KEY,
      { key: keyOrId },
    );
    if (!r.ok) return r;
    const team = r.data.teams.nodes[0];
    if (!team) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `Team with key '${keyOrId}' not found`,
        retriable: false,
      };
    }
    return { ok: true, data: { team }, status: r.status };
  }

  public async getComments(
    issueId: string,
    maxResults: number,
  ): Promise<
    LinearResult<{
      issue: {
        comments: {
          nodes: LinearComment[];
          pageInfo: { hasNextPage: boolean };
        };
      } | null;
    }>
  > {
    return this.query(GET_COMMENTS, { id: issueId, first: maxResults });
  }

  public async listAttachments(
    issueId: string,
  ): Promise<
    LinearResult<{
      issue: { attachments: { nodes: LinearAttachment[] } } | null;
    }>
  > {
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
  }): Promise<
    LinearResult<{
      issueCreate: { success: boolean; issue: LinearIssueSummary };
    }>
  > {
    return this.query(CREATE_ISSUE, { input });
  }

  public async updateIssue(
    id: string,
    input: {
      title?: string;
      description?: string;
      assigneeId?: string;
      stateId?: string;
      priority?: number;
    },
  ): Promise<
    LinearResult<{
      issueUpdate: {
        success: boolean;
        issue: { id: string; identifier: string; updatedAt: string };
      };
    }>
  > {
    return this.query(UPDATE_ISSUE, { id, input });
  }

  public async archiveIssue(
    id: string,
  ): Promise<LinearResult<{ issueArchive: { success: boolean } }>> {
    return this.query(ARCHIVE_ISSUE, { id });
  }

  public async addComment(input: {
    issueId: string;
    body: string;
  }): Promise<
    LinearResult<{
      commentCreate: { success: boolean; comment: LinearComment };
    }>
  > {
    return this.query(ADD_COMMENT, { input });
  }

  public async updateComment(
    id: string,
    input: { body: string },
  ): Promise<
    LinearResult<{
      commentUpdate: {
        success: boolean;
        comment: { id: string; body: string; updatedAt: string };
      };
    }>
  > {
    return this.query(UPDATE_COMMENT, { id, input });
  }

  public async deleteComment(
    id: string,
  ): Promise<LinearResult<{ commentDelete: { success: boolean } }>> {
    return this.query(DELETE_COMMENT, { id });
  }

  public async attachmentLink(input: {
    issueId: string;
    title: string;
    url: string;
    subtitle?: string;
    metadata?: Record<string, unknown>;
  }): Promise<
    LinearResult<{
      attachmentCreate: {
        success: boolean;
        attachment: {
          id: string;
          title: string;
          url: string;
          createdAt: string;
        };
      };
    }>
  > {
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
  assignee: {
    id: string;
    name: string;
    email: string;
    displayName: string;
  } | null;
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
  user: {
    id: string;
    name: string;
    displayName: string;
    email: string;
  } | null;
}

export interface LinearAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  createdAt: string;
  creator: { displayName: string } | null;
}
