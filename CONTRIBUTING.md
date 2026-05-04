# Contributing to `narai-primitives`

Thanks for your interest in contributing. Most contributions fall into one of two buckets:

1. **Fixes / improvements to existing code** — see [Fixes and improvements](#fixes-and-improvements) below for the local-dev loop, conventions, and PR hygiene.
2. **A brand-new builtin connector** — read the [New builtin connector](#new-builtin-connector) section. It describes the file layout, naming, testing, and marketplace surfacing expected of a new builtin.

If you instead want a **local connector** for your own project (private API, internal tool, one-off), don't add it here. Use the `/create-connector` Claude Code skill (shipped via the [`narai`](https://github.com/narailabs/narai-claude-plugins) marketplace) — it scaffolds a minimal local connector at `.connectors/connectors/<slug>/` with no plugin layer, no publish step, no `git init`. Builtins are reserved for connectors useful enough that bundling them in the core npm package and shipping a Claude Code plugin for them is justified.

## Fixes and improvements

### Before you start

Read [`docs/architecture-invariants.md`](docs/architecture-invariants.md) — four load-bearing invariants that have each failed at least once between 2.1.0 and 2.1.3 despite green unit tests. If your change touches `src/toolkit/agent_resolver.ts`, `src/hub/index.ts`, `src/credentials/`, `src/connectors/db/lib/drivers/`, or `src/connectors/db/dispatcher.ts`, that doc is required reading.

### Local dev loop

```sh
npm install
npm run build
npm test
```

Live-DB integration tests are gated behind `TEST_LIVE_*` env vars (e.g. `TEST_LIVE_POSTGRES=1`) and stay skipped by default so CI is hermetic. `npm run typecheck` runs the strict pass without emitting; `npm run coverage` runs the full suite with v8 coverage and enforces global thresholds.

### Code conventions

- 2-space indent, ESM-only (`"type": "module"`).
- Strict TypeScript with `exactOptionalPropertyTypes` (see `tsconfig.json`); don't widen the compiler options to silence errors.
- No emojis in source or docs.
- Follow existing file/module style; don't reformat adjacent code.

### Releasing

Releases are tag-driven via `.github/workflows/release.yml`. Bump `package.json` version, then:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

This triggers `npm publish --provenance` plus a GitHub Release. The workflow fails closed if the tag doesn't match `package.json`. Pre-release tags (`vX.Y.Z-rc.N`) publish under the `next` npm dist-tag and are marked as pre-releases on GitHub; plain semver tags go to `latest`.

### PR hygiene

- Include test coverage for behavior changes.
- If you touch one of the four invariant paths above, run doc-wiki's `eval-14` (`wiki-gather-credential-boundary`) and `eval-20` (`wiki-gather-db-postgres-success`) manually before merging — both exercise the full `gather()` → connector subprocess → bundled `SKILL.md` → CLI → envelope round-trip and have caught bugs that passed unit tests in this repo. doc-wiki lives at <https://github.com/narailabs/doc-wiki>.
- Keep PRs focused; don't bundle drive-by refactors with the core change.

## New builtin connector

Before you start:

- Check that the service isn't already covered. Today's builtins: `aws`, `confluence`, `db` (postgres / mysql / sqlite / mssql / mongodb / dynamodb / oracle), `gcp`, `github`, `jira`, `notion`. Database backends not yet supported by `db` should usually go into `db`'s driver registry rather than start fresh.
- File an issue first if you're unsure whether the connector belongs here. Adding a builtin is a long-term commitment to maintain it.
- The connector must be **read-only** by default (or have a clearly delineated read-only mode). Write/delete/admin actions go through the toolkit's policy gate; we expect the contributor to explicitly classify them.

## Repo layout for a new builtin connector

`jira` is the canonical reference. Mirror its shape:

```
src/connectors/<slug>/
  index.ts               factory using createConnector from narai-primitives/toolkit
  cli.ts                 thin bin entry; loads env via narai-primitives/config
  lib/
    <slug>_client.ts     HTTP/SDK client + loadCredentials + Result type
    <slug>_error.ts      service-specific error class
    (other helpers)

plugins/<slug>-agent/
  .claude-plugin/
    plugin.json          plugin manifest with independent version
  package.json           runtime install metadata for SessionStart hook
  bin/<slug>-agent       executable bash shim that exec's the connector CLI
  hooks/
    hooks.json           SessionStart / PostToolUse / SessionEnd hooks
    reminder.mjs         optional credential reminder
  commands/<slug>-agent.md
  skills/<slug>-agent/SKILL.md
  README.md

tests/connectors/<slug>/
  unit/                  cli + client unit tests (vitest)
  integration/           framework.test.ts at minimum
  live/                  optional, gated behind TEST_LIVE_<SLUG>=1
```

## Files to add or modify

### New files

| File | Notes |
|---|---|
| `src/connectors/<slug>/index.ts` | Build the connector via `createConnector({ name, version, actions })` from `narai-primitives/toolkit`. Each action: `{ description, params: ZodSchema, classify, handler }`. See `src/connectors/jira/index.ts`. |
| `src/connectors/<slug>/cli.ts` | Identical pattern to `src/connectors/jira/cli.ts`: import `loadConnectorEnvironment` from `narai-primitives/config`, declare an env-mapping (`{ config_key: ENV_VAR_NAME }`), then call `connector.main(process.argv.slice(2))`. |
| `src/connectors/<slug>/lib/<slug>_client.ts` | HTTP client (or SDK wrapper). Export `load<Service>Credentials()`, the client class, and a `<Service>Result<T>` discriminated union for handler returns. |
| `src/connectors/<slug>/lib/<slug>_error.ts` | Service-specific `Error` subclass tagged with an `ErrorCode` from the toolkit. |
| `plugins/<slug>-agent/.claude-plugin/plugin.json` | `{ "name": "<slug>-agent-plugin", "version": "1.0.0", ... }`. Plugin version is independent of the bundle version. |
| `plugins/<slug>-agent/package.json` | Runtime install metadata used by the plugin's SessionStart hook to materialize the connector binary inside the user's plugin data dir. Mirror `plugins/jira-agent/package.json`. |
| `plugins/<slug>-agent/bin/<slug>-agent` | Bash shim that `exec node`s the installed CLI. Mirror `plugins/jira-agent/bin/jira-agent` exactly; remember `chmod +x` after writing. |
| `plugins/<slug>-agent/hooks/hooks.json` | Mirror `plugins/jira-agent/hooks/hooks.json`. Set `USAGE_CONNECTOR_NAME` to `<slug>` in each block. |
| `plugins/<slug>-agent/skills/<slug>-agent/SKILL.md` | "Use when the user asks about ..." — the trigger phrase block goes in the frontmatter `description`. The body lists actions and credentials. |
| `plugins/<slug>-agent/commands/<slug>-agent.md` | Slash-command wrapper. See `plugins/jira-agent/commands/jira-agent.md`. |
| `plugins/<slug>-agent/README.md` | One-screen credentials + license note. |
| `tests/connectors/<slug>/unit/cli.test.ts` | One happy-path test per action invocation through the CLI. |
| `tests/connectors/<slug>/unit/<slug>_client_extras.test.ts` | One test per public client method asserting URL, method, headers. |
| `tests/connectors/<slug>/integration/framework.test.ts` | Connector-toolkit framework smoke test. See `tests/connectors/jira/integration/framework.test.ts`. |

### Existing files to modify

| File | Edit |
|---|---|
| `package.json` `exports` | Add `"./<slug>": { "types": "./dist/connectors/<slug>/index.d.ts", "import": "./dist/connectors/<slug>/index.js" }` |
| `package.json` `bin` | Add `"<slug>-agent-connector": "./dist/connectors/<slug>/cli.js"` |
| `README.md` | Add the new subpath to the bundle table |

## Naming conventions

| Thing | Form | Example |
|---|---|---|
| Service slug | lowercase, hyphens allowed | `jira`, `acme-msg` |
| Subpath import | `narai-primitives/<slug>` | `narai-primitives/jira` |
| Bin name (back-compat) | `<slug>-agent-connector` | `jira-agent-connector` |
| Plugin directory | `plugins/<slug>-agent/` | `plugins/jira-agent/` |
| Plugin name (in `plugin.json`) | `<slug>-agent-plugin` | `jira-agent-plugin` |
| Plugin name (in marketplace) | `<slug>-agent` | `jira-agent` |
| Source library files | underscores instead of hyphens | `acme_msg_client.ts`, `acme_msg_error.ts` |
| Env var prefix | uppercase, underscores | `JIRA_API_TOKEN`, `ACME_MSG_TOKEN` |
| Connector class name (PascalCase) | strip hyphens / underscores | `Jira`, `AcmeMsg` |

## Action classification

The toolkit's policy gate routes each action by classification. Pick the right one per action:

| Classification | When |
|---|---|
| `read` | Pure reads. `get_*`, `list_*`, `search_*`, `query_*`, `fetch_*`. |
| `write` | Creates / updates. `create_*`, `update_*`, `post_*`, `send_*`. |
| `delete` | Removes data. `delete_*`, `remove_*`, `archive_*`. |
| `admin` | Configuration / settings changes. |
| `privilege` | Identity / permissions changes. `grant_*`, `revoke_*`. |

Default approval modes:

- `read` → `auto`
- `write` → `confirm_once`
- `delete` → `confirm_each`
- `admin` / `privilege` → `grant_required`

Override only with a written reason in the PR description.

## Testing expectations

- **Unit tests per action.** Happy path through the CLI plus a per-method client test asserting URL, method, and headers. Mirror `tests/connectors/jira/unit/`.
- **Framework test.** One `tests/connectors/<slug>/integration/framework.test.ts` exercising the toolkit envelope shape (status field, error code values, classification routing). Use `tests/connectors/jira/integration/framework.test.ts` as the template.
- **Live tests are optional and gated.** If you write a live test that hits a real API, gate it behind `TEST_LIVE_<SLUG>=1` and document the required env vars in the test file's header. Live tests must default to skipped so CI stays hermetic.
- **Coverage thresholds.** `npm run coverage` enforces global thresholds; new connector code must clear them. Run locally before opening the PR.

Required commands before pushing:

```sh
npm run typecheck
npm run build
npm test
npm run coverage
```

## Marketplace surfacing

Plugins are exposed to Claude Code via the [`narailabs/narai-claude-plugins`](https://github.com/narailabs/narai-claude-plugins) marketplace. After your bundle PR merges, open a follow-up PR there adding an entry to `.claude-plugin/marketplace.json`:

```json
{
  "name": "<slug>-agent",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/narailabs/narai-primitives.git",
    "path": "plugins/<slug>-agent",
    "ref": "main"
  },
  "description": "<one-line description — what data the connector exposes>",
  "version": "1.0.0",
  "author": { "name": "NarAI Labs" }
}
```

Bump the marketplace `version` in the same file (patch bump for a new connector entry).

## Versioning

- The bundle's `package.json` version drives library + CLI releases. Tag pushes (`v*.*.*`) trigger the release workflow which publishes to npm.
- Each plugin's `plugin.json` `version` is independent. Bump it only when the plugin layer changes (hooks, command, skill, README), not on every bundle release.

## PR checklist

- [ ] All files in the layout above present
- [ ] `npm run typecheck && npm run build && npm test && npm run coverage` clean locally
- [ ] `package.json` `exports` and `bin` updated
- [ ] `README.md` lists the new subpath
- [ ] PR description states why the service belongs as a builtin (not as a local connector via `/create-connector`)
- [ ] Action classifications justified if any are non-`read`
- [ ] Follow-up marketplace PR linked or noted

## Reference material

- `src/connectors/jira/` — canonical connector source layout
- `plugins/jira-agent/` — canonical plugin layout
- `tests/connectors/jira/` — canonical test layout
- `src/toolkit/` — `createConnector`, policy gate, audit, hardship, envelope contract
- `src/hub/` — `gather()` planning + dispatch (you don't usually touch this when adding a connector)
- `src/config/` — `loadConnectorEnvironment`, config resolution
