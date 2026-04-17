# @narai/credential-providers

Pluggable secret-resolution for Node apps. Four built-in backends, one interface, no lock-in.

- **`EnvVarProvider`** — `process.env` lookup with verbatim-then-normalized matching (`DB_PASSWORD` → `env:db-password`).
- **`FileProvider`** — JSON file with flat keys or dotted paths; refuses group/world-readable files (POSIX `0o077` check).
- **`KeychainProvider`** — macOS (`security`) and Linux (`secret-tool`). Windows intentionally unsupported.
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

Known prefixes: `env` / `env_var`, `keychain`, `file`, `cloud` / `cloud_secrets`. Unknown prefixes pass through as literals.

## Chain semantics

`resolveSecret(name, {provider, fallback})` tries each backend in order. Behaviour:

- A `null` return (miss) falls through to the next backend.
- A thrown error is remembered; the chain keeps going.
- If **any** backend returns — even `null` — success/miss wins and errors are suppressed.
- If **every** backend threw, the last error is re-thrown.

This lets a transient AWS network blip fall through to keychain without the user seeing an error.

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
