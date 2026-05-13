/**
 * _m365/auth.ts — Microsoft 365 (Microsoft Graph) shared authentication.
 * Used by teams-connector and outlook-connector.
 *
 * Loads MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REFRESH_TOKEN
 * via the credentials resolver (env + provider chain), and wraps a single
 * `ConfidentialClientApplication` per `M365Auth` instance. Access tokens
 * are cached in memory until <5min of `expiresOn` remains.
 *
 * The MSAL token cache (account + rotated refresh token) is persisted to
 * disk via the standard `cachePlugin` pattern. Default location:
 * `~/.connectors/m365/cache.json` (override with `M365_CACHE_PATH`). File
 * mode 0600, parent dir 0700. Atomic writes (tmpfile + rename).
 *
 * On startup, MSAL deserializes the cache, finds the cached account, and
 * uses `acquireTokenSilent` — the cached (already-rotated) refresh token
 * is used internally. The env-supplied `MS_REFRESH_TOKEN` is only consulted
 * on first run (or after cache loss) as the bootstrap grant.
 *
 * Single-process assumption — no file locking. Concurrent processes
 * writing to the same cache get last-writer-wins on rotation; acceptable
 * for v0 since Entra accepts the previous RT for ~24h after rotation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfidentialClientApplication,
  type TokenCacheContext,
} from "@azure/msal-node";
import { resolveSecret } from "narai-primitives/credentials";
import { M365Error } from "./error.js";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export interface M365Credentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function emptyToNull(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}

export async function loadM365Credentials(): Promise<M365Credentials | null> {
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

function defaultCachePath(): string {
  return (
    process.env["M365_CACHE_PATH"] ??
    path.join(os.homedir(), ".connectors", "m365", "cache.json")
  );
}

function buildCachePlugin(cachePath: string) {
  return {
    beforeCacheAccess: async (ctx: TokenCacheContext): Promise<void> => {
      try {
        const data = await fs.promises.readFile(cachePath, "utf-8");
        ctx.tokenCache.deserialize(data);
      } catch (err) {
        // Missing file on first run is expected — proceed with empty cache.
        // Other errors (perms, corruption) also fall through to empty cache;
        // the bootstrap refresh-token grant will re-seed it on next acquire.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // intentionally swallow — see comment above
        }
      }
    },
    afterCacheAccess: async (ctx: TokenCacheContext): Promise<void> => {
      if (!ctx.cacheHasChanged) return;
      const dir = path.dirname(cachePath);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, ctx.tokenCache.serialize(), {
        mode: 0o600,
      });
      await fs.promises.rename(tmp, cachePath);
    },
  };
}

/**
 * Process-instance MSAL wrapper. One instance per connector client. Lazy-inits
 * `ConfidentialClientApplication` on first `getAccessToken()` call. Persists
 * the MSAL token cache to disk so refresh-token rotation survives restarts.
 */
export class M365Auth {
  private readonly _tenantId: string;
  private readonly _clientId: string;
  private readonly _clientSecret: string;
  private readonly _bootstrapRefreshToken: string;
  private readonly _cachePath: string;
  private _app: ConfidentialClientApplication | null = null;
  private _cached: CachedToken | null = null;

  constructor(creds: M365Credentials, opts: { cachePath?: string } = {}) {
    this._tenantId = creds.tenantId;
    this._clientId = creds.clientId;
    this._clientSecret = creds.clientSecret;
    this._bootstrapRefreshToken = creds.refreshToken;
    this._cachePath = opts.cachePath ?? defaultCachePath();
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
    const result = await this._acquire(app);
    if (!result || !result.accessToken) {
      throw new M365Error(
        "AUTH_ERROR",
        "Failed to acquire access token: empty response",
        false,
      );
    }
    const expiresAt = result.expiresOn?.getTime() ?? Date.now();
    if (this._isExpiringSoon(expiresAt)) {
      throw new M365Error(
        "AUTH_ERROR",
        "Failed to acquire access token: token expired immediately",
        false,
      );
    }
    this._cached = { accessToken: result.accessToken, expiresAt };
    return result.accessToken;
  }

  /**
   * Prefer `acquireTokenSilent` against the persisted cache (which holds the
   * latest rotated refresh token). On first run / cache loss, fall back to
   * `acquireTokenByRefreshToken` with the env-supplied bootstrap RT, which
   * populates the cache so subsequent calls go silent.
   */
  private async _acquire(app: ConfidentialClientApplication) {
    try {
      const accounts = await app.getTokenCache().getAllAccounts();
      const account = accounts[0];
      if (account !== undefined) {
        const silent = await app.acquireTokenSilent({
          account,
          scopes: [GRAPH_DEFAULT_SCOPE],
        });
        if (silent) return silent;
      }
    } catch {
      // Silent path failed (cache stale, account mismatch, etc.) — fall
      // through to the bootstrap refresh-token grant.
    }
    try {
      return await app.acquireTokenByRefreshToken({
        refreshToken: this._bootstrapRefreshToken,
        scopes: [GRAPH_DEFAULT_SCOPE],
        forceCache: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new M365Error(
        "AUTH_ERROR",
        `Failed to acquire access token: ${message}`,
        false,
      );
    }
  }

  private _getApp(): ConfidentialClientApplication {
    if (this._app !== null) return this._app;
    this._app = new ConfidentialClientApplication({
      auth: {
        clientId: this._clientId,
        authority: `https://login.microsoftonline.com/${this._tenantId}`,
        clientSecret: this._clientSecret,
      },
      cache: { cachePlugin: buildCachePlugin(this._cachePath) },
    });
    return this._app;
  }

  private _isExpiringSoon(expiresAt: number): boolean {
    return expiresAt - Date.now() < EXPIRY_SAFETY_MARGIN_MS;
  }
}
