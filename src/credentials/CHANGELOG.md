# Changelog
All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-04-17

### Added
- `CredentialProvider.getSecretSync?(name): string | null` — optional synchronous lookup for callers that cannot `await`. Implemented on `EnvVarProvider` and `FileProvider`, whose backing stores are themselves sync (`process.env`, `fs.readFileSync`). `KeychainProvider` and `CloudSecretsProvider` intentionally do not implement it — their backends are async-only. Semantics match `getSecret`: same parsing, same POSIX `0o077` mode refusal, same dot-path traversal, `null` on miss.
- `KNOWN_PROVIDERS` export — frozen readonly tuple of built-in short names (`"env"`, `"keychain"`, `"file"`, `"cloud"`) plus a `KnownProvider` type alias for narrowing.

### Security
- `CloudSecretsProvider` (`gcp` sub-provider) validates the secret name against `/^[a-zA-Z][a-zA-Z0-9_-]{0,254}$/` before interpolating it into the `projects/<id>/secrets/<name>/versions/<v>` resource path. Caller-supplied names with path separators or other metachars now throw locally instead of reaching the API.

## [0.2.0] - 2026-04-17

### Added
- `CredentialResolver` class — own a registry per instance, enabling isolation between plugins/libraries that share the process.
- `defaultResolver` export — the module-level singleton backing the free functions.
- `resolveSecrets(specs, { strict? })` — batch resolution with parallel dispatch. Aliases you pick map to `provider:key` refs; results come back keyed by alias. Per-alias failures surface as an `AggregateError` whose `.errors` are tagged with the alias name.
- `describeSecret(name)` — optional method on `CredentialProvider` returning `SecretMetadata` (`{exists, version?, lastModified?, provider}`). Built-ins default to `{exists, provider}`; `FileProvider` adds `lastModified` from the file's mtime. Cloud providers may override to surface real version/rotation metadata later.
- `redact(needle, haystack)` and `redactAll(needles, haystack)` — log-safe scrubbing utilities. Needles shorter than 4 chars are skipped to avoid collision with common tokens.
- `parseCredentialRef` now also accepts URI form: `env://DB_PASSWORD`, `keychain://prod-db`, `cloud://api-key`, `file:///etc/creds.json#db.password`. Bare `provider:key` still works.
- `ParseCredentialRefOptions` — `{ strict?, resolver? }`. In `strict: true` mode, unknown provider prefixes throw instead of returning null.
- `CloudSecretsProvider.forTesting({ client, …config })` — public, supported alternative to the old `_client` injection hook.
- `cacheTtlMs` option on `CloudSecretsProvider` — opt-in in-memory TTL cache for getSecret (default 0 = off). Errors are never cached. `clearCache()` method for manual invalidation.
- `cacheTtlMs` option on `FileProvider` — same pattern: default `Infinity` (current behavior), opt into re-reads after a TTL. `clearCache()` forces a refresh.
- `allowLoosePermissions` option on `FileProvider` — explicit opt-out of the POSIX mode check, decoupled from the warning-suppression flag.
- `KeychainProvider` now supports Windows via optional lazy-loaded `@napi-rs/keyring` peer dep (macOS and Linux continue to shell out to `security` / `secret-tool`).
- `bench/` suite — `npm run bench` runs tinybench against the hot paths (env_var normalization, parseCredentialRef, resolver chain, FileProvider cold/cached load).
- `SECURITY.md` — vulnerability reporting contact, supported-versions policy.

### Changed
- **BREAKING**: `CredentialProvider.getSecretSync?` removed from the interface; `EnvVarProvider.getSecretSync`, `FileProvider.getSecretSync`, `KeychainProvider.getSecretSync` removed. Use `await p.getSecret(name)`. The sync surface was never used internally and was blocking-unsafe on keychain backends.
- **BREAKING**: `resolveSecret` now throws `AggregateError` (with `.errors` preserving every thrown error) when every provider in the chain throws, instead of re-throwing only the last error. Consumers that `try/catch` the rejection get richer diagnostics.
- **BREAKING**: `FileProvider`'s `suppressWarning` option no longer bypasses the POSIX 0o077 mode check. Consumers who need loose permissions must now set `allowLoosePermissions: true`.
- **BREAKING**: `CloudSecretsConfig._client` field removed from the public interface. Use `CloudSecretsProvider.forTesting(...)` instead.
- **BREAKING**: `KNOWN_PROVIDERS` no longer exported. Reference-string recognition is now driven by the resolver's registry plus a small built-in fallback allowlist (`env_var`, `keychain`, `file`, `cloud_secrets`). Custom providers registered via `registerProvider` are automatically recognized by `parseCredentialRef`.
- `package.json` `description` no longer mentions internal consumers — the package stands on its own.
- `package.json` `repository`, `bugs`, `homepage` point at `narailabs/credential-providers`.
- Node `engines` widened from `>=20.0.0 <21.0.0` to `>=20.0.0` — Node 22 LTS is supported.
- Internal-consumer references (`wiki_db`, `Phase H`, `doc-wiki`, `wiki.config.yaml`) scrubbed from source and test comments.

## [0.1.0] - 2026-04-16
### Added
- Initial release: pluggable credential providers for Node.
- EnvVarProvider, FileProvider, KeychainProvider (macOS/Linux), CloudSecretsProvider (AWS/GCP/Azure).
- `parseCredentialRef` for `provider:key` reference strings.
- `resolveSecret(name, {provider, fallback})` chain helper.
