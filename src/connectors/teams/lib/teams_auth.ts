/**
 * teams_auth.ts — Microsoft Graph delegated OAuth, refresh-token flow.
 *
 * Loads MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REFRESH_TOKEN
 * via the credentials resolver (env + provider chain), and wraps a single
 * `ConfidentialClientApplication` per `TeamsAuth` instance. Access tokens
 * are cached in memory until <5min of their `expiresOn` remains, then a
 * refresh-token grant is issued against `https://graph.microsoft.com/.default`
 * (the `.default` scope tells Entra to use the app registration's
 * pre-consented delegated scopes).
 *
 * MSAL rotates the refresh token internally inside its `TokenCache`. We do
 * not persist that cache to disk for v0 — the in-memory cache lives as long
 * as the `TeamsAuth` instance does. On restart, the env-supplied
 * MS_REFRESH_TOKEN is used again. Operators rotating refresh tokens out of
 * band must update the env var.
 */
import { ConfidentialClientApplication } from "@azure/msal-node";
import { resolveSecret } from "narai-primitives/credentials";
import { TeamsError } from "./teams_error.js";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export interface TeamsCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function emptyToNull(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}

export async function loadTeamsCredentials(): Promise<TeamsCredentials | null> {
  const tenantId = emptyToNull(
    (await resolveSecret("MS_TENANT_ID")) ?? process.env["MS_TENANT_ID"] ?? null,
  );
  const clientId = emptyToNull(
    (await resolveSecret("MS_CLIENT_ID")) ?? process.env["MS_CLIENT_ID"] ?? null,
  );
  const clientSecret = emptyToNull(
    (await resolveSecret("MS_CLIENT_SECRET")) ?? process.env["MS_CLIENT_SECRET"] ?? null,
  );
  const refreshToken = emptyToNull(
    (await resolveSecret("MS_REFRESH_TOKEN")) ?? process.env["MS_REFRESH_TOKEN"] ?? null,
  );
  if (!tenantId || !clientId || !clientSecret || !refreshToken) return null;
  return { tenantId, clientId, clientSecret, refreshToken };
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch millis
}

/**
 * Process-instance MSAL wrapper. One instance per `TeamsClient`. Lazy-inits
 * `ConfidentialClientApplication` on first `getAccessToken()` call.
 */
export class TeamsAuth {
  private readonly _tenantId: string;
  private readonly _clientId: string;
  private readonly _clientSecret: string;
  private _refreshToken: string;
  private _app: ConfidentialClientApplication | null = null;
  private _cached: CachedToken | null = null;

  constructor(creds: TeamsCredentials) {
    this._tenantId = creds.tenantId;
    this._clientId = creds.clientId;
    this._clientSecret = creds.clientSecret;
    this._refreshToken = creds.refreshToken;
  }

  /** Tenant id reachable from the factory's `scope()` callback. */
  public get tenantId(): string {
    return this._tenantId;
  }

  /**
   * Invalidate the cached access token so the next call forces a refresh.
   * Called by the HTTP client after a 401 to retry once with a fresh token.
   */
  public invalidate(): void {
    this._cached = null;
  }

  public async getAccessToken(): Promise<string> {
    if (this._cached !== null && !this._isExpiringSoon(this._cached.expiresAt)) {
      return this._cached.accessToken;
    }
    const app = this._getApp();
    let result;
    try {
      result = await app.acquireTokenByRefreshToken({
        refreshToken: this._refreshToken,
        scopes: [GRAPH_DEFAULT_SCOPE],
        forceCache: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TeamsError(
        "AUTH_ERROR",
        `Failed to acquire access token: ${message}`,
        false,
      );
    }
    if (!result || !result.accessToken) {
      throw new TeamsError(
        "AUTH_ERROR",
        "Failed to acquire access token: empty response",
        false,
      );
    }
    const expiresAt = result.expiresOn?.getTime() ?? Date.now();
    if (this._isExpiringSoon(expiresAt)) {
      throw new TeamsError(
        "AUTH_ERROR",
        "Failed to acquire access token: token expired immediately",
        false,
      );
    }
    // MSAL rotates the refresh token internally in its TokenCache; attempt
    // to extract the new RT from the serialized cache and update our copy
    // so subsequent in-memory calls always use the freshest one.
    this._captureRotatedRefreshToken();
    this._cached = { accessToken: result.accessToken, expiresAt };
    return result.accessToken;
  }

  private _getApp(): ConfidentialClientApplication {
    if (this._app !== null) return this._app;
    this._app = new ConfidentialClientApplication({
      auth: {
        clientId: this._clientId,
        authority: `https://login.microsoftonline.com/${this._tenantId}`,
        clientSecret: this._clientSecret,
      },
    });
    return this._app;
  }

  private _isExpiringSoon(expiresAt: number): boolean {
    return expiresAt - Date.now() < EXPIRY_SAFETY_MARGIN_MS;
  }

  /**
   * Best-effort: read the MSAL in-memory cache, find the most recently
   * stored refresh-token entry, and update `_refreshToken`. If anything
   * fails we silently keep the existing RT — the next call will still work
   * because MSAL itself uses the cached RT internally.
   */
  private _captureRotatedRefreshToken(): void {
    if (this._app === null) return;
    try {
      const serialized = this._app.getTokenCache().serialize();
      const parsed = JSON.parse(serialized) as {
        RefreshToken?: Record<string, { secret?: string }>;
      };
      const rts = parsed.RefreshToken;
      if (!rts) return;
      // There should be at most one RT per principal in our flow. Pick the
      // first secret we see.
      for (const entry of Object.values(rts)) {
        if (entry && typeof entry.secret === "string" && entry.secret.length > 0) {
          this._refreshToken = entry.secret;
          return;
        }
      }
    } catch {
      // Cache shape may evolve across MSAL versions — never let this throw.
    }
  }
}
