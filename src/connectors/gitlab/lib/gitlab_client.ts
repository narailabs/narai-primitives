/**
 * gitlab_client.ts — GitLab REST client. Thin wrapper over the shared
 * `HttpClient` in `narai-primitives/toolkit`: supplies Bearer auth,
 * sets baseUrl to `<host>/api/v4`, and allows all five HTTP methods.
 *
 * Per-domain methods (createMr, addNote, retryPipeline, etc.) are added
 * in later tasks; only `getProject` is present here for extras tests.
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

  // ── Concrete method (for extras tests; domain methods land in later tasks) ─

  public async getProject(
    namespace: string,
    project: string,
  ): Promise<GitlabResult<GitlabProject>> {
    return this.get<GitlabProject>(`/projects/${this.projectPath(namespace, project)}`);
  }
}
