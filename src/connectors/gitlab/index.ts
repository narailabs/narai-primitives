/**
 * @narai/gitlab-connector — GitLab REST connector.
 *
 * Exposes 14 read, 18 write, and 1 admin action across projects,
 * issues, merge requests, notes, releases, and CI pipelines. Writes
 * escalate by default and admin is denied until the operator opts in
 * via ~/.gitlab-connector/config.yaml; see SKILL.md for the full surface.
 *
 * Built on @narai/connector-toolkit. Self-hosted GitLab is supported
 * via GITLAB_HOST env var or YAML config.
 */
import {
  ConnectorError,
  createConnector,
  mapHttpError,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import { GitlabClient, loadGitlabCredentials } from "./lib/gitlab_client.js";
import { loadGitlabBehavior } from "./lib/gitlab_config.js";
import { buildReadActions } from "./actions/reads.js";
import { buildMergesActions } from "./actions/merges.js";
import { buildIssuesActions } from "./actions/issues.js";
import { buildNotesActions } from "./actions/notes.js";
import { buildReleasesActions } from "./actions/releases.js";
import { buildPipelinesActions } from "./actions/pipelines.js";

const CODE_MAP: Record<string, ErrorCode> = {
  UNAUTHORIZED: "AUTH_ERROR",
  FORBIDDEN: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "CONNECTION_ERROR",
  SERVER_ERROR: "CONNECTION_ERROR",
  BAD_REQUEST: "VALIDATION_ERROR",
  UNPROCESSABLE: "VALIDATION_ERROR",
  INVALID_URL: "VALIDATION_ERROR",
  METHOD_NOT_ALLOWED: "VALIDATION_ERROR",
  HTTP_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  CONFLICT: "VALIDATION_ERROR",
};

export interface BuildOptions {
  sdk?: () => Promise<GitlabClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

export function gitlabScope(ctx: {
  sdk: GitlabClient;
  action: string;
  params: unknown;
}): string | null {
  const ns = ctx.sdk.defaultNamespace;
  if (!ns) return null;
  return `${ctx.sdk.host}/${ns}`;
}

export function buildGitlabConnector(overrides: BuildOptions = {}): Connector {
  // load credentials default
  const defaultCredentials = async () => {
    const creds = await loadGitlabCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  // default SDK constructor reads credentials & wraps in GitlabClient
  const defaultSdk = async () => {
    const creds = await loadGitlabCredentials();
    if (!creds) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        "GitLab credentials not configured. Set GITLAB_TOKEN (personal access token) or register a credential provider via narai-primitives/credentials.",
        false,
      );
    }
    return new GitlabClient({
      token: creds.token,
      host: creds.host,
      ...(creds.defaultNamespace ? { defaultNamespace: creds.defaultNamespace } : {}),
    });
  };

  const behavior = loadGitlabBehavior();

  return createConnector<GitlabClient>({
    name: "gitlab",
    version: "1.0.0",
    scope: gitlabScope,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    policyFloorAspects: ["delete"],
    defaultPolicy: {
      read: "success",
      write: "escalate",
      admin: "denied",
      aspects: { delete: "escalate" },
    },
    actions: {
      ...buildReadActions({ behavior }),
      ...buildMergesActions({ behavior }),
      ...buildIssuesActions({ behavior }),
      ...buildNotesActions({ behavior }),
      ...buildReleasesActions({ behavior }),
      ...buildPipelinesActions({ behavior }),
    },
    mapError: mapHttpError(CODE_MAP),
  });
}

// Default production connector instance
const connector = buildGitlabConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for callers / tests
export {
  GitlabClient,
  loadGitlabCredentials,
  type GitlabClientOptions,
  type GitlabResult,
} from "./lib/gitlab_client.js";
export { ConnectorError as GitlabError } from "narai-primitives/toolkit";
