# Auth patterns

The skill supports the common auth schemes natively. For each, this doc shows what the scaffold produces and what the user has to provide.

## Pattern 1: Bearer token via env var (default)

The dominant case. Notion, Linear, Stripe, most public REST APIs.

**Interview answer**: `bearer-token-env-var` + env var name (e.g., `STRIPE_API_KEY`).

**Scaffold output**:

- `src/cli.ts`:
  ```ts
  const STRIPE_ENV_MAPPING: Record<string, string> = {
    token: "STRIPE_API_KEY",
  };
  ```
- `src/lib/stripe_client.ts` `loadStripeCredentials()`:
  ```ts
  const token = (await resolveSecret("STRIPE_API_KEY")) ?? process.env["STRIPE_API_KEY"] ?? null;
  if (!token) return null;
  return { token };
  ```
- `_authHeaders()`:
  ```ts
  return {
    Authorization: `Bearer ${this._token}`,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  ```

## Pattern 2: API-key header (X-API-Key etc.)

For services that reject `Authorization: Bearer` and want a custom header. Think internal APIs, some partner integrations.

**Interview answer**: `api-key-header-env-var` + env var name + header name (e.g., `X-API-Key`).

**Scaffold differences from pattern 1**: `_authHeaders()` becomes:
```ts
return {
  "X-API-Key": this._token,
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};
```

The `loadCredentials` and `cli.ts` env mapping are otherwise the same — only the header construction differs.

## Pattern 3: Multi-secret (token + extra context)

Like GitHub, where the token alone isn't sufficient — you also need an owner / org / workspace ID. The cli.ts env mapping has multiple entries:

```ts
const GITHUB_ENV_MAPPING: Record<string, string> = {
  token: "GITHUB_TOKEN",
  owner: "GITHUB_OWNER",
};
```

**Scaffold differences**: 
- `ServiceClientOptions` adds extra fields (`owner: string`, etc.).
- `loadCredentials()` resolves all of them; missing required fields return `null`.
- The client class stores the extras as private fields and uses them when constructing URLs (e.g., `${this._apiBase}/repos/${this._owner}/...`).

## Pattern 4: Basic auth (username + password)

Rare in modern APIs but still seen with internal tooling.

**Interview answer**: `basic-auth` + env var names for user + pass.

**Scaffold differences**: `_authHeaders()` becomes:
```ts
const credentials = Buffer.from(`${this._user}:${this._pass}`).toString("base64");
return {
  Authorization: `Basic ${credentials}`,
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};
```

## Pattern 5: OAuth with refresh tokens (NOT TEMPLATED)

The skill does **not** scaffold OAuth flows. None of the existing connectors implement this; it's genuinely novel territory per service.

**What the scaffold produces**: a placeholder `loadCredentials()` that throws `CONFIG_ERROR` with a TODO message:
```ts
export async function loadServiceCredentials(): Promise<{ access_token: string } | null> {
  // TODO: implement OAuth flow.
  // - Read a refresh token from `resolveSecret("SERVICE_REFRESH_TOKEN")`
  // - Exchange it at the provider's token endpoint for an access token
  // - Cache the access token (in-memory or via credential-providers) until expiry
  // See https://oauth.net/2/grant-types/refresh-token/ for the canonical flow.
  throw new Error("OAuth not implemented — see TODO in loadServiceCredentials");
}
```

The user fills this in. The skill flags this clearly during interview and the post-scaffold next-steps.

## Pattern 6: Custom (mTLS, signed URLs, anything else)

For schemes that don't fit any of the above (mutual TLS, request signing, ephemeral session tokens). The skill scaffolds with a simplified `loadCredentials()` that returns an empty object and points the user at:

- `notion-agent-connector/src/lib/notion_client.ts` for a Bearer reference
- `aws-agent-connector` (in the workspace) for SDK-mediated credentials

## Where credentials get resolved at runtime

The `cli.ts` runs `loadConnectorEnvironment("<slug>", { envMapping })` from `@narai/connector-config`. This:

1. Reads `~/.connectors/config.yaml` (or `NARAI_CONFIG_BLOB` if injected by `connector-hub`).
2. Maps configured fields (`token`, `owner`, etc.) to env var names per `envMapping`.
3. Sets `process.env.<NAME>` only if not already set — existing env wins.

Inside the client, `resolveSecret(envName)` from `@narai/credential-providers` checks cloud-backed stores first, then falls back to `process.env`. This means a user can either:

- Set `STRIPE_API_KEY` directly in their shell, OR
- Configure it in `~/.connectors/config.yaml`, OR
- Register a custom credential provider via `@narai/credential-providers`

All three paths work without code changes.
