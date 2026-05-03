# @narai/credential-providers

Pluggable secret-resolution for Node apps. Four built-in backends, one interface, no lock-in.

- **`EnvVarProvider`** — `process.env` lookup with verbatim-then-normalized matching (`DB_PASSWORD` → `env:db-password`).
- **`FileProvider`** — JSON file with flat keys or dotted paths; refuses group/world-readable files (POSIX `0o077` check). Optional `cacheTtlMs` refreshes the parsed JSON after the TTL elapses; `clearCache()` invalidates it on demand.
- **`KeychainProvider`** — macOS (`security`), Linux (`secret-tool`), and Windows (`@napi-rs/keyring`, optional peer dep — see [Platform support](#platform-support)).
- **`CloudSecretsProvider`** — dispatcher over AWS Secrets Manager, GCP Secret Manager, Azure Key Vault. Each SDK loaded lazily via dynamic `import()` so you only pay for the one you use.

The library is pure TypeScript with **no runtime dependencies**. Cloud SDKs are loaded on demand and must be installed by the consumer when that sub-provider is used — the library prints the exact `npm install` command if a required SDK is missing.

## Install

```bash
npm install @narai/credential-providers
```

For cloud sub-providers, install the SDK you plan to use:

```bash
# AWS Secrets Manager
npm install @aws-sdk/client-secrets-manager

# GCP Secret Manager
npm install @google-cloud/secret-manager

# Azure Key Vault
npm install @azure/keyvault-secrets @azure/identity
```

## Platform support

`KeychainProvider` backends by platform:

| Platform | Backend                  | Extra install               |
| -------- | ------------------------ | --------------------------- |
| macOS    | `security` (built-in)    | none                        |
| Linux    | `secret-tool` (libsecret) | `apt install libsecret-tools` |
| Windows  | `@napi-rs/keyring`        | `npm install --save-dev @napi-rs/keyring` |

On Windows, `KeychainProvider` stores and retrieves secrets through Windows Credential Manager via the [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) N-API binding. It is declared as an optional peer dependency so macOS and Linux users don't pay the native-binding install cost. The library lazy-imports it only when `process.platform === "win32"`, and prints a clear install hint if it's missing.

## Usage

```ts
import {
  EnvVarProvider,
  KeychainProvider,
  FileProvider,
  registerProvider,
  resolveSecret,
} from "@narai/credential-providers";

// Register backends in order of preference.
registerProvider("env_var", new EnvVarProvider());
registerProvider("keychain", new KeychainProvider());
registerProvider("file", new FileProvider({ path: "/etc/my-secrets.json" }));

// Look up a secret with fallback.
const password = await resolveSecret("db-prod", {
  provider: "keychain",
  fallback: ["env_var", "file"],
});
```

### Reference-string syntax

Config files often store `provider:key` references instead of raw secrets:

```yaml
password: env:PGPASSWORD
token:    keychain:github
aws_key:  cloud:prod-api-key
pg_cert:  file:/etc/creds.json:prod.sslcert
```

Parse them with `parseCredentialRef`:

```ts
import { parseCredentialRef, resolveSecret } from "@narai/credential-providers";

const ref = parseCredentialRef(configValue);
if (ref === null) {
  // Plain literal; use as-is.
  return configValue;
}
return await resolveSecret(ref.key, { provider: ref.provider });
```

Known prefixes: `env` / `env_var`, `keychain`, `file`, `cloud` / `cloud_secrets`. The short forms are also exported as `KNOWN_PROVIDERS` (a frozen readonly tuple) for consumers that iterate over or narrow against the catalog. Unknown prefixes pass through as literals.

#### URI-form references

`parseCredentialRef` also accepts the familiar `scheme://…` URI form, which some config tools quote or escape more cleanly than bare `provider:key`:

```yaml
password: env://PGPASSWORD
token:    keychain://github
aws_key:  cloud://prod-api-key
pg_cert:  file:///etc/creds.json#prod.sslcert
```

Both forms are interchangeable — `env:PGPASSWORD` and `env://PGPASSWORD` parse to the same `{provider: "env_var", key: "PGPASSWORD"}`. For `file://` URIs, the fragment after `#` carries the dotted key inside the JSON and is folded back into the FileProvider's native `path:dotted.key` shape. Windows drive paths (`file:///C:/creds.json#user`) are preserved verbatim.

Unknown schemes behave exactly like unknown bare prefixes — `null` by default, or `throw` when called with `{ strict: true }`.

## Sync path

Callers that cannot `await` (module-level config resolution, legacy synchronous dispatchers) can use `getSecretSync(name): string | null` on the providers whose backing store is itself synchronous:

| Provider                  | `getSecretSync`?                                    |
| ------------------------- | --------------------------------------------------- |
| `EnvVarProvider`          | yes — reads `process.env`                           |
| `FileProvider`            | yes — uses `fs.readFileSync` with the same mode/symlink checks as the async path |
| `KeychainProvider`        | no — native keychain APIs are async-only            |
| `CloudSecretsProvider`    | no — AWS/GCP/Azure SDKs are network-bound and async |

Semantics match `getSecret`: same parsing, same dot-path traversal, same POSIX `0o077` refusal, `null` on miss, throws on corrupt input. Reach for the async path whenever you can — it's the only surface that covers every backend.

```ts
import { EnvVarProvider, FileProvider } from "@narai/credential-providers";

const env = new EnvVarProvider();
const file = new FileProvider({ path: "/etc/creds.json" });

const token = env.getSecretSync("GITHUB_TOKEN") ?? file.getSecretSync("github.token");
```

## Chain semantics

`resolveSecret(name, {provider, fallback})` tries each backend in order. Behaviour:

- A `null` return (miss) falls through to the next backend.
- A thrown error is remembered; the chain keeps going.
- If **any** backend returns — even `null` — success/miss wins and errors are suppressed.
- If **every** backend threw, the last error is re-thrown.

This lets a transient AWS network blip fall through to keychain without the user seeing an error.

## Resolving multiple secrets at once

`resolveSecrets(specs)` parses each reference, fires every lookup in parallel, and collects results under the alias you pick:

```ts
import { resolveSecrets } from "@narai/credential-providers";

const { db, token } = await resolveSecrets({
  db:    "env:PGPASSWORD",
  token: "keychain:github",
});
```

Misses return `null` for that alias. Pass `{ strict: true }` to throw if any alias misses. Per-alias failures surface as an `AggregateError` whose `.errors` are each tagged with the alias name.

## Metadata

Every provider exposes `describeSecret(name)` for an existence check without leaking the value:

```ts
import { FileProvider } from "@narai/credential-providers";

const provider = new FileProvider({ path: "/etc/creds.json" });
const meta = await provider.describeSecret("db.password");
// { exists: true, provider: "file", lastModified: Date }
```

The built-in providers report `{exists, provider}` (plus `lastModified` from `FileProvider`). Custom backends can override to surface real version/lastModified fields.

## Redacting secrets from logs

Once a secret is resolved, keep it out of logs and error reports with `redact`:

```ts
import { resolveSecret, redact } from "@narai/credential-providers";

const token = await resolveSecret("gh-token");
try { await doWork(); }
catch (err) {
  console.error(redact(token!, String(err.stack)));
  throw err;
}
```

Needles shorter than 4 characters are skipped — too likely to collide with common tokens like `api` or `key`. Pass multiple secrets at once with `redactAll(iterable, haystack)`.

## Writing a custom provider

Implement the two-method interface:

```ts
import type { CredentialProvider } from "@narai/credential-providers";

class VaultProvider implements CredentialProvider {
  async getSecret(name: string): Promise<string | null> {
    // Return null on miss; throw on genuine error.
  }
}

registerProvider("vault", new VaultProvider());
```

## License

MIT.
