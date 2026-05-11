/**
 * @narai/github-agent-connector — read-only GitHub connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector` instance; `buildGithubConnector(overrides?)` is exposed for
 * tests that want to inject a fake GitHub client.
 */
import {
  ConnectorError,
  createConnector,
  mapHttpError,
  type Connector,
  type ErrorCode,
} from "narai-primitives/toolkit";
import {
  GithubClient,
  loadGithubCredentials,
} from "./lib/github_client.js";
import { loadGithubBehavior } from "./lib/github_config.js";
import { buildReadActions } from "./actions/reads.js";
import { buildPullsActions } from "./actions/pulls.js";
import { buildIssuesActions } from "./actions/issues.js";

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation
// ───────────────────────────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<GithubClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

/**
 * Scope callback installed into the toolkit config. Returns
 * `${host}/${defaultOwner}` when a tenant owner is configured, otherwise
 * `null` (global tier). Exported for unit testing.
 */
export function githubScope(ctx: {
  sdk: GithubClient;
  action: string;
  params: unknown;
}): string | null {
  const owner = ctx.sdk.defaultOwner;
  if (!owner) return null;
  return `${ctx.sdk.host}/${owner}`;
}

export function buildGithubConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadGithubCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<GithubClient> => {
    const creds = await loadGithubCredentials();
    if (!creds) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        "GitHub credentials not configured. Set GITHUB_TOKEN (personal access " +
          "token) or register a credential provider via narai-primitives/credentials.",
        false,
      );
    }
    return new GithubClient({
      token: creds.token,
      ...(creds.defaultOwner ? { defaultOwner: creds.defaultOwner } : {}),
    });
  };

  const behavior = loadGithubBehavior();

  return createConnector<GithubClient>({
    name: "github",
    version: "3.0.1",
    scope: githubScope,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    actions: {
      ...buildReadActions({ behavior }),
      ...buildPullsActions({ behavior }),
      ...buildIssuesActions({ behavior }),
    },
    mapError: mapHttpError(CODE_MAP),
  });
}

// Default production connector.
const connector = buildGithubConnector();
export default connector;
export const { main, fetch, validActions } = connector;

export {
  GithubClient,
  loadGithubCredentials,
  type GithubClientOptions,
  type GithubResult,
} from "./lib/github_client.js";
export { ConnectorError as GithubError } from "narai-primitives/toolkit";
