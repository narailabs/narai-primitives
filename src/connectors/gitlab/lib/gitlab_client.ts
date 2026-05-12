/**
 * gitlab_client.ts — GitLab REST client. Thin wrapper over the shared
 * `HttpClient` in `narai-primitives/toolkit`: supplies Bearer auth,
 * sets baseUrl to `<host>/api/v4`, and allows all five HTTP methods.
 *
 * Read methods added in Task 3: searchCode, listIssues, getIssue,
 * listMergeRequests, getMergeRequest, getFile, getNotes, listReleaseLinks,
 * getReleaseLink, listPipelines, getPipeline, listPipelineJobs, getJobLogs.
 */
import {
  HttpClient,
  type HttpResult,
} from "narai-primitives/toolkit";
import { resolveSecret } from "narai-primitives/credentials";

const GITLAB_DEFAULT_HOST = "https://gitlab.com";

// ── Options & types ──────────────────────────────────────────────────────────

export interface GitlabClientOptions {
  token: string;
  host?: string;
  defaultNamespace?: string;
  rateLimitPerMin?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type GitlabResult<T> = HttpResult<T>;

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch?: string;
  description?: string | null;
  visibility?: string;
  web_url?: string;
  ssh_url_to_repo?: string;
  http_url_to_repo?: string;
}

export interface GitlabSearchBlob {
  filename: string;
  path: string;
  ref: string;
  startline: number;
  project_id: number;
}

export interface GitlabIssue {
  iid: number;
  title: string;
  state: string;
  author?: { username?: string };
  labels?: string[];
  description?: string | null;
  web_url?: string;
  updated_at?: string;
}

export interface GitlabMergeRequest {
  iid: number;
  title: string;
  state: string;
  author?: { username?: string };
  description?: string | null;
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  draft?: boolean;
  web_url?: string;
  updated_at?: string;
}

export interface GitlabFileContent {
  file_name: string;
  file_path: string;
  size: number;
  encoding: string;
  content: string;
  ref: string;
  blob_id?: string;
  commit_id?: string;
  last_commit_id?: string;
}

export interface GitlabNote {
  id: number;
  body: string;
  author?: { username?: string };
  created_at?: string;
  updated_at?: string;
  system?: boolean;
}

export interface GitlabReleaseLink {
  id: number;
  name: string;
  url: string;
  link_type?: string;
}

export interface GitlabPipeline {
  id: number;
  status: string;
  ref: string;
  sha?: string;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  duration?: number | null;
  finished_at?: string | null;
}

export interface GitlabJob {
  id: number;
  name: string;
  stage?: string;
  status: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
  web_url?: string;
}

// ── Credential loader ────────────────────────────────────────────────────────

export async function loadGitlabCredentials(): Promise<{
  token: string;
  host: string;
  defaultNamespace: string | null;
} | null> {
  const token =
    (await resolveSecret("GITLAB_TOKEN")) ??
    process.env["GITLAB_TOKEN"] ??
    null;
  if (!token) return null;

  const host =
    (await resolveSecret("GITLAB_HOST")) ??
    process.env["GITLAB_HOST"] ??
    GITLAB_DEFAULT_HOST;

  const defaultNamespace =
    (await resolveSecret("GITLAB_NAMESPACE")) ??
    process.env["GITLAB_NAMESPACE"] ??
    null;

  return { token, host, defaultNamespace };
}

// ── GitlabClient ─────────────────────────────────────────────────────────────

export class GitlabClient {
  private readonly _http: HttpClient;
  private readonly _defaultNamespace: string | null;

  constructor(opts: GitlabClientOptions) {
    const host = opts.host ?? GITLAB_DEFAULT_HOST;
    this._defaultNamespace = opts.defaultNamespace ?? null;
    this._http = new HttpClient({
      baseUrl: `${host}/api/v4`,
      authHeader: `Bearer ${opts.token}`,
      serviceName: "GitLab",
      allowedMethods: new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      rateLimitPerMin: opts.rateLimitPerMin,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    });
  }

  public get host(): string {
    return this._http.host;
  }

  public get defaultNamespace(): string | null {
    return this._defaultNamespace;
  }

  /**
   * Encodes `namespace/project` for use in GitLab project API paths.
   * All slashes (including those in group/subgroup paths) are percent-encoded.
   * Example: projectPath("group/sub", "proj") → "group%2Fsub%2Fproj"
   */
  public projectPath(namespace: string, project: string): string {
    return encodeURIComponent(`${namespace}/${project}`);
  }

  // ── Minimal HTTP wrappers ────────────────────────────────────────────────

  public async get<T = unknown>(
    relPath: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<GitlabResult<T>> {
    return this._http.request<T>("GET", relPath, { query });
  }

  public async post<T = unknown>(
    relPath: string,
    body?: Record<string, unknown>,
  ): Promise<GitlabResult<T>> {
    return this._http.request<T>("POST", relPath, { body });
  }

  public async patch<T = unknown>(
    relPath: string,
    body?: Record<string, unknown>,
  ): Promise<GitlabResult<T>> {
    return this._http.request<T>("PATCH", relPath, { body });
  }

  public async put<T = unknown>(
    relPath: string,
    body?: Record<string, unknown>,
  ): Promise<GitlabResult<T>> {
    return this._http.request<T>("PUT", relPath, { body });
  }

  public async delete<T = unknown>(relPath: string): Promise<GitlabResult<T>> {
    return this._http.request<T>("DELETE", relPath);
  }

  // ── Read methods ─────────────────────────────────────────────────────────

  public async getProject(
    namespace: string,
    project: string,
  ): Promise<GitlabResult<GitlabProject>> {
    return this.get<GitlabProject>(`/projects/${this.projectPath(namespace, project)}`);
  }

  public async searchCode(
    namespace: string,
    project: string,
    query: string,
  ): Promise<GitlabResult<GitlabSearchBlob[]>> {
    return this.get<GitlabSearchBlob[]>(
      `/projects/${this.projectPath(namespace, project)}/search`,
      { scope: "blobs", search: query },
    );
  }

  public async listIssues(
    namespace: string,
    project: string,
    query: { state?: string; per_page?: number; page?: number } = {},
  ): Promise<GitlabResult<GitlabIssue[]>> {
    return this.get<GitlabIssue[]>(
      `/projects/${this.projectPath(namespace, project)}/issues`,
      { state: query.state, per_page: query.per_page, page: query.page },
    );
  }

  public async getIssue(
    namespace: string,
    project: string,
    iid: number,
  ): Promise<GitlabResult<GitlabIssue>> {
    return this.get<GitlabIssue>(
      `/projects/${this.projectPath(namespace, project)}/issues/${iid}`,
    );
  }

  public async listMergeRequests(
    namespace: string,
    project: string,
    query: { state?: string; per_page?: number; page?: number } = {},
  ): Promise<GitlabResult<GitlabMergeRequest[]>> {
    return this.get<GitlabMergeRequest[]>(
      `/projects/${this.projectPath(namespace, project)}/merge_requests`,
      { state: query.state, per_page: query.per_page, page: query.page },
    );
  }

  public async getMergeRequest(
    namespace: string,
    project: string,
    iid: number,
  ): Promise<GitlabResult<GitlabMergeRequest>> {
    return this.get<GitlabMergeRequest>(
      `/projects/${this.projectPath(namespace, project)}/merge_requests/${iid}`,
    );
  }

  /**
   * Fetches a file at a given ref. The path itself is URL-encoded because
   * GitLab requires the file path to be encoded in the URL segment.
   */
  public async getFile(
    namespace: string,
    project: string,
    filePath: string,
    ref = "main",
  ): Promise<GitlabResult<GitlabFileContent>> {
    return this.get<GitlabFileContent>(
      `/projects/${this.projectPath(namespace, project)}/repository/files/${encodeURIComponent(filePath)}`,
      { ref },
    );
  }

  /**
   * Fetches notes (comments) on an issue or merge request.
   * `noteableType` is "issue" | "merge_request"; maps to URL segment
   * "issues" or "merge_requests".
   */
  public async getNotes(
    namespace: string,
    project: string,
    noteableType: "issue" | "merge_request",
    iid: number,
  ): Promise<GitlabResult<GitlabNote[]>> {
    const segment = noteableType === "issue" ? "issues" : "merge_requests";
    return this.get<GitlabNote[]>(
      `/projects/${this.projectPath(namespace, project)}/${segment}/${iid}/notes`,
    );
  }

  public async listReleaseLinks(
    namespace: string,
    project: string,
    tag: string,
  ): Promise<GitlabResult<GitlabReleaseLink[]>> {
    return this.get<GitlabReleaseLink[]>(
      `/projects/${this.projectPath(namespace, project)}/releases/${encodeURIComponent(tag)}/assets/links`,
    );
  }

  public async getReleaseLink(
    namespace: string,
    project: string,
    tag: string,
    linkId: number,
  ): Promise<GitlabResult<GitlabReleaseLink>> {
    return this.get<GitlabReleaseLink>(
      `/projects/${this.projectPath(namespace, project)}/releases/${encodeURIComponent(tag)}/assets/links/${linkId}`,
    );
  }

  public async listPipelines(
    namespace: string,
    project: string,
    query: { ref?: string; status?: string; per_page?: number; page?: number } = {},
  ): Promise<GitlabResult<GitlabPipeline[]>> {
    return this.get<GitlabPipeline[]>(
      `/projects/${this.projectPath(namespace, project)}/pipelines`,
      { ref: query.ref, status: query.status, per_page: query.per_page, page: query.page },
    );
  }

  public async getPipeline(
    namespace: string,
    project: string,
    pipelineId: number,
  ): Promise<GitlabResult<GitlabPipeline>> {
    return this.get<GitlabPipeline>(
      `/projects/${this.projectPath(namespace, project)}/pipelines/${pipelineId}`,
    );
  }

  public async listPipelineJobs(
    namespace: string,
    project: string,
    pipelineId: number,
  ): Promise<GitlabResult<GitlabJob[]>> {
    return this.get<GitlabJob[]>(
      `/projects/${this.projectPath(namespace, project)}/pipelines/${pipelineId}/jobs`,
    );
  }

  /** Returns the job trace log as a plain text string. */
  public async getJobLogs(
    namespace: string,
    project: string,
    jobId: number,
  ): Promise<GitlabResult<string>> {
    return this._http.request<string>(
      "GET",
      `/projects/${this.projectPath(namespace, project)}/jobs/${jobId}/trace`,
      { responseType: "text" },
    );
  }

  // ── Issue mutations ──────────────────────────────────────────────────────

  public async createIssue(
    namespace: string,
    project: string,
    body: {
      title: string;
      description?: string;
      assignee_ids?: number[];
      labels?: string;
      milestone_id?: number;
      due_date?: string;
    },
  ): Promise<GitlabResult<GitlabIssue>> {
    return this.post<GitlabIssue>(
      `/projects/${this.projectPath(namespace, project)}/issues`,
      body as Record<string, unknown>,
    );
  }

  public async updateIssue(
    namespace: string,
    project: string,
    iid: number,
    body: {
      title?: string;
      description?: string;
      assignee_ids?: number[];
      labels?: string;
      milestone_id?: number;
      due_date?: string;
      state_event?: "reopen";
    },
  ): Promise<GitlabResult<GitlabIssue>> {
    return this.put<GitlabIssue>(
      `/projects/${this.projectPath(namespace, project)}/issues/${iid}`,
      body as Record<string, unknown>,
    );
  }

  public async closeIssue(
    namespace: string,
    project: string,
    iid: number,
  ): Promise<GitlabResult<GitlabIssue>> {
    return this.put<GitlabIssue>(
      `/projects/${this.projectPath(namespace, project)}/issues/${iid}`,
      { state_event: "close" },
    );
  }

  // ── Merge request mutations ──────────────────────────────────────────────

  public async createMergeRequest(
    namespace: string,
    project: string,
    body: {
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
      assignee_ids?: number[];
      reviewer_ids?: number[];
      labels?: string;
      milestone_id?: number;
      remove_source_branch?: boolean;
      squash?: boolean;
      draft?: boolean;
    },
  ): Promise<GitlabResult<GitlabMergeRequest>> {
    return this.post<GitlabMergeRequest>(
      `/projects/${this.projectPath(namespace, project)}/merge_requests`,
      body as Record<string, unknown>,
    );
  }

  public async updateMergeRequest(
    namespace: string,
    project: string,
    iid: number,
    body: {
      title?: string;
      description?: string;
      target_branch?: string;
      assignee_ids?: number[];
      reviewer_ids?: number[];
      labels?: string;
      milestone_id?: number;
      state_event?: "reopen";
      remove_source_branch?: boolean;
      squash?: boolean;
    },
  ): Promise<GitlabResult<GitlabMergeRequest>> {
    return this.put<GitlabMergeRequest>(
      `/projects/${this.projectPath(namespace, project)}/merge_requests/${iid}`,
      body as Record<string, unknown>,
    );
  }

  public async closeMergeRequest(
    namespace: string,
    project: string,
    iid: number,
  ): Promise<GitlabResult<GitlabMergeRequest>> {
    return this.put<GitlabMergeRequest>(
      `/projects/${this.projectPath(namespace, project)}/merge_requests/${iid}`,
      { state_event: "close" },
    );
  }

  public async mergeMergeRequest(
    namespace: string,
    project: string,
    iid: number,
    body: {
      merge_commit_message?: string;
      squash_commit_message?: string;
      should_remove_source_branch?: boolean;
      merge_when_pipeline_succeeds?: boolean;
      sha?: string;
      squash?: boolean;
    } = {},
  ): Promise<GitlabResult<{ sha: string; merged: boolean; message: string }>> {
    return this.put<{ sha: string; merged: boolean; message: string }>(
      `/projects/${this.projectPath(namespace, project)}/merge_requests/${iid}/merge`,
      body as Record<string, unknown>,
    );
  }

  // ── Note mutations ───────────────────────────────────────────────────────

  private noteSegment(noteableType: "issue" | "merge_request"): string {
    return noteableType === "issue" ? "issues" : "merge_requests";
  }

  public async addNote(
    namespace: string,
    project: string,
    noteableType: "issue" | "merge_request",
    iid: number,
    body: { body: string; position?: Record<string, unknown> },
  ): Promise<GitlabResult<GitlabNote>> {
    return this.post<GitlabNote>(
      `/projects/${this.projectPath(namespace, project)}/${this.noteSegment(noteableType)}/${iid}/notes`,
      body as Record<string, unknown>,
    );
  }

  public async updateNote(
    namespace: string,
    project: string,
    noteableType: "issue" | "merge_request",
    iid: number,
    noteId: number,
    body: { body: string },
  ): Promise<GitlabResult<GitlabNote>> {
    return this.put<GitlabNote>(
      `/projects/${this.projectPath(namespace, project)}/${this.noteSegment(noteableType)}/${iid}/notes/${noteId}`,
      body as Record<string, unknown>,
    );
  }

  public async deleteNote(
    namespace: string,
    project: string,
    noteableType: "issue" | "merge_request",
    iid: number,
    noteId: number,
  ): Promise<GitlabResult<null>> {
    return this.delete<null>(
      `/projects/${this.projectPath(namespace, project)}/${this.noteSegment(noteableType)}/${iid}/notes/${noteId}`,
    );
  }
}
