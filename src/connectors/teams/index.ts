/**
 * narai-primitives/teams — Microsoft Teams (Microsoft Graph) connector.
 *
 * Exposes ~25 actions across directory (teams, channels, chats, users),
 * messaging (channel + chat reads/writes, reactions, search), meetings
 * (online meetings, transcripts, recordings, transcript fan-out search),
 * and attachments. Writes escalate by default; the `delete` aspect is
 * floored (cannot be downgraded to `success`).
 *
 * Auth: delegated OAuth via `@azure/msal-node` using a long-lived refresh
 * token. Bootstrap (one-time auth-code exchange) is performed out of band;
 * v0 reads MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REFRESH_TOKEN
 * from the credentials resolver or environment.
 */
import {
  ConnectorError,
  createConnector,
  type Connector,
  type ErrorCode,
  type ErrorEnvelope,
} from "narai-primitives/toolkit";
import { TeamsClient } from "./lib/teams_client.js";
import { TeamsAuth, loadTeamsCredentials } from "./lib/teams_auth.js";
import { TeamsError } from "./lib/teams_error.js";
import { buildDirectoryActions } from "./actions/directory.js";
import { buildMessagesActions } from "./actions/messages.js";
import { buildMeetingsActions } from "./actions/meetings.js";
import { buildAttachmentsActions } from "./actions/attachments.js";

// ── Error-code translation: Graph code → toolkit canonical ErrorCode ───────

const GRAPH_CODE_MAP: Record<string, ErrorCode> = {
  // Authentication / authorization
  InvalidAuthenticationToken: "AUTH_ERROR",
  UnauthenticatedRequest: "AUTH_ERROR",
  Authorization_IdentityNotFound: "AUTH_ERROR",
  Forbidden: "AUTH_ERROR",
  AccessDenied: "AUTH_ERROR",
  Authorization_RequestDenied: "AUTH_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  // Not found
  NotFound: "NOT_FOUND",
  itemNotFound: "NOT_FOUND",
  Request_ResourceNotFound: "NOT_FOUND",
  ResourceNotFound: "NOT_FOUND",
  // Rate-limit
  TooManyRequests: "RATE_LIMITED",
  activityLimitReached: "RATE_LIMITED",
  // Validation
  BadRequest: "VALIDATION_ERROR",
  invalidRequest: "VALIDATION_ERROR",
  Request_BadRequest: "VALIDATION_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  // 5xx / availability
  ServiceNotAvailable: "CONNECTION_ERROR",
  ServiceUnavailable: "CONNECTION_ERROR",
  InternalServerError: "CONNECTION_ERROR",
  generalException: "CONNECTION_ERROR",
  UnknownError: "CONNECTION_ERROR",
  NetworkError: "CONNECTION_ERROR",
  // Timeout
  timeout: "TIMEOUT",
  Timeout: "TIMEOUT",
  gatewayTimeout: "TIMEOUT",
  // Config
  CONFIG_ERROR: "CONFIG_ERROR",
};

function mapByHttpStatus(status: number | undefined): ErrorCode {
  if (status === undefined) return "CONNECTION_ERROR";
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 404) return "NOT_FOUND";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  if (status >= 500) return "CONNECTION_ERROR";
  return "CONNECTION_ERROR";
}

const RETRIABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMITED",
  "TIMEOUT",
  "CONNECTION_ERROR",
]);

function customMapError(err: unknown, _action: string): Partial<ErrorEnvelope> | undefined {
  if (err instanceof TeamsError || err instanceof ConnectorError) {
    const mapped = GRAPH_CODE_MAP[err.code] ?? mapByHttpStatus(err.httpStatus);
    return {
      error_code: mapped,
      message: err.message,
      retriable: err.retriable || RETRIABLE.has(mapped),
    };
  }
  return undefined;
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<TeamsClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

export function teamsScope(ctx: {
  sdk: TeamsClient;
  action: string;
  params: unknown;
}): string | null {
  return ctx.sdk.tenantId || null;
}

export function buildTeamsConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    const creds = await loadTeamsCredentials();
    return (creds as unknown as Record<string, unknown> | null) ?? {};
  };

  const defaultSdk = async (): Promise<TeamsClient> => {
    const creds = await loadTeamsCredentials();
    if (!creds) {
      throw new ConnectorError(
        "CONFIG_ERROR",
        "Teams credentials not configured. Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REFRESH_TOKEN, or register a credential provider via narai-primitives/credentials.",
        false,
      );
    }
    const auth = new TeamsAuth(creds);
    return new TeamsClient({ auth });
  };

  return createConnector<TeamsClient>({
    name: "teams",
    version: "1.0.0",
    scope: teamsScope,
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
      ...buildDirectoryActions(),
      ...buildMessagesActions(),
      ...buildMeetingsActions(),
      ...buildAttachmentsActions(),
    },
    mapError: customMapError,
  });
}

// Default production connector instance
const connector = buildTeamsConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for callers / tests
export {
  TeamsClient,
  type TeamsClientOptions,
  type TeamsResult,
} from "./lib/teams_client.js";
export { TeamsAuth, loadTeamsCredentials, type TeamsCredentials } from "./lib/teams_auth.js";
export { TeamsError } from "./lib/teams_error.js";
