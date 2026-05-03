# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run the full vitest suite (runs from `src/` via Bundler resolution; does **not** require a build first).
- `npx vitest run tests/<file>.test.ts` — run a single test file.
- `npx vitest run -t "<name pattern>"` — filter by test name.
- `npm run typecheck` — `tsc --noEmit`. CI runs this before `npm test`.
- `npm run build` — `tsc` emits to `dist/` (declarations + JS). Only needed before `npm run bench` or `npm publish`.
- `npm run bench` — tinybench suites under `bench/`. **Imports from `dist/`, so run `npm run build` first.**

Node `>=20.0.0` (22 LTS supported). Package is ESM-only (`"type": "module"`).

## Architecture

### Two-layer resolver

`src/index.ts` exports both a `CredentialResolver` class (per-instance registry) and a module-level `defaultResolver` with thin bound delegators (`registerProvider`, `resolveSecret`, `resolveSecrets`, …). Library consumers that want isolation instantiate their own resolver; the free functions all operate on the singleton. Both paths are first-class — don't assume one is preferred.

### Provider interface

Every backend implements `CredentialProvider` from `src/index.ts`: a required `getSecret(name): Promise<string | null>` plus an optional `describeSecret(name): Promise<SecretMetadata | null>`. The contract around the return value is load-bearing:

- `null` = miss → chain falls through to next provider.
- `throw` = error → collected into an `errors[]` array; chain keeps going.
- If **any** provider in the chain runs to completion (hit or miss), the chain returns that result and suppresses collected errors.
- If **every** provider throws, the resolver raises `AggregateError` (not the last error — `.errors` preserves all of them, in order).

`resolveSecrets(specs)` is the parallel batch variant: it parses every ref up front with `strict: true` (typos surface at batch time), fires lookups via `Promise.allSettled`, and wraps per-alias failures into an `AggregateError` whose `.errors` are each tagged with the alias name.

### Reference-string grammar (`src/parse_ref.ts`)

Accepts two interchangeable forms:
- Bare: `env:DB_PASSWORD`, `keychain:gh`, `file:/etc/creds.json:db.password`, `cloud:api-key`.
- URI: `env://DB_PASSWORD`, `file:///etc/creds.json#db.password`, `cloud://api-key`.

Known aliases: `env` / `env_var`, `keychain`, `file`, `cloud` / `cloud_secrets`. Custom providers registered via `registerProvider` are also auto-recognized. Unknown prefixes return `null` (or throw under `{strict: true}`).

### Zero runtime deps — lazy SDK loading

`package.json` has no `dependencies`. Cloud SDKs (`@aws-sdk/client-secrets-manager`, `@google-cloud/secret-manager`, `@azure/keyvault-secrets` + `@azure/identity`) and `@napi-rs/keyring` (Windows keychain) are loaded via dynamic `import()` only when their code path runs. If missing, each provider throws with the exact `npm install` command. When adding a new cloud sub-provider, preserve this pattern — never add a top-level `import` of an optional SDK.

### File layout

Each backend is one file in `src/`:
- `env_var.ts` — verbatim-then-normalized `process.env` lookup (`db-password` → `DB_PASSWORD`).
- `file.ts` — JSON file with flat or dotted keys; refuses `0o077`-readable files unless `allowLoosePermissions: true` (separate flag from `suppressWarning`). Optional `cacheTtlMs` with manual `clearCache()`.
- `keychain.ts` — shells out to `security` (macOS) or `secret-tool` (Linux); lazy-loads `@napi-rs/keyring` on Windows.
- `cloud_secrets.ts` — dispatcher keyed by `subProvider`; use `CloudSecretsProvider.forTesting({ client, … })` to inject a mock instead of the removed `_client` field.
- `redact.ts` — `redact` / `redactAll`; needles shorter than 4 chars are skipped to avoid collision with common tokens like `api` / `key`.

Tests live in `tests/<module>.test.ts` (one file per `src/` module) and import from `src/…` (path + `.js` suffix, resolved by bundler-style `moduleResolution` in `tsconfig.json`).

## Gotchas

- `tsconfig.json` has `noUncheckedIndexedAccess: true`. Array/record reads return `T | undefined`; expect to narrow.
- A provider that returns `null` is **not** an error — it's a miss and the chain continues. Throw only on genuine failures (network, permission denied), never to signal absence.
- `FileProvider` will throw on group/world-readable credential files. Tests that write fixtures must `chmod 0600` (or pass `allowLoosePermissions`).
- Release is tag-triggered: `.github/workflows/release.yml` fires on `v*.*.*` tags and **verifies `package.json.version` matches the tag** before publishing. Bump `package.json` and update `CHANGELOG.md` in the same commit you tag.
- `CHANGELOG.md` follows Keep a Changelog; every breaking change is called out as `**BREAKING**`. Preserve that convention.
