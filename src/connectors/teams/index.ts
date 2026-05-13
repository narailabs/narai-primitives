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
} from "narai-primitives/toolkit";
import { TeamsClient } from "./lib/teams_client.js";
import {
  M365Auth as TeamsAuth,
  loadM365Credentials as loadTeamsCredentials,
} from "../_m365/auth.js";
import { makeM365MapError } from "../_m365/error.js";
import { buildDirectoryActions } from "./actions/directory.js";
import { buildMessagesActions } from "./actions/messages.js";
import { buildMeetingsActions } from "./actions/meetings.js";
import { buildAttachmentsActions } from "./actions/attachments.js";

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
    mapError: makeM365MapError(),
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
export {
  M365Auth as TeamsAuth,
  loadM365Credentials as loadTeamsCredentials,
  type M365Credentials as TeamsCredentials,
} from "../_m365/auth.js";
export { M365Error as TeamsError } from "../_m365/error.js";
