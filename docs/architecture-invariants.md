# Architecture Invariants

This document captures four load-bearing invariants in narai-primitives 2.x. Each
exists because consolidating ten previously-separate packages into one bundled
layout broke assumptions baked into the original per-package code. Three of the
four invariants were violated at least once between 2.1.0 and 2.1.3 — every
violation passed unit tests and only surfaced when an end-to-end caller
(doc-wiki) actually invoked `gather()` against the bundled tree.

Read this before refactoring `agent_resolver.ts`, `hub/index.ts`,
`credentials/`, `connectors/db/lib/drivers/`, or `connectors/db/dispatcher.ts`.

## 1. Resolver: `bundled-self` step

**What it is.** The connector-CLI resolver in `src/toolkit/agent_resolver.ts`
must check a `bundled-self` location — `<narai-primitives root>/dist/connectors/<name>/cli.js`
— before falling through to the plugin-cache, `CLAUDE_PLUGIN_DATA`, and dev
fallbacks. The package root is derived from `import.meta.url`.

**Where it lives.**

- `src/toolkit/agent_resolver.ts`, `defaultBundledSelfRoot()` (~line 101) and
  the `bundled-self` branch inside `resolveAgentCli` (~line 129).

**Why it exists.** Pre-2.0, every connector shipped as its own npm package and
its CLI lived at the root of that package's `dist/`. Consolidating into
`narai-primitives` moved every CLI under `dist/connectors/<name>/cli.js`. Without
the `bundled-self` step the resolver returned `null`, and `gather()` failed at
plan-dispatch time with `CLI_NOT_FOUND` for any consumer that simply did
`npm install narai-primitives` (no plugin-cache entry, no env override).

**How it's locked in.** `tests/toolkit/agent_resolver.test.ts`. The test named
`"bundled-self resolves a CLI inside narai-primitives' own dist tree"` constructs
a fake bundled root and asserts the resolver returns `source: "bundled-self"`.
Other tests in the same file pass `bundledSelfRoot: null` to exercise the
remaining fallbacks in isolation.

**History.** Bug shipped in 2.1.0; fixed in 2.1.1.

## 2. Hub `prepareConnector`: 4-up package root + bundled SKILL.md candidate

**What it is.** Inside `src/hub/index.ts`, `prepareConnector` derives the
package root from the resolved CLI path and reads `SKILL.md`. Two helpers
encode the bundled layout:

- `packageRootFromCli(cliPath)` walks up four levels (`dist/connectors/<name>/cli.js`
  → root) for the bundled layout, two levels (`dist/cli.js` → root) for the
  legacy per-package layout. The discriminator is whether the segment after
  `dist/` is literal `connectors`.
- `skillMdCandidates(root, name)` returns
  `[<root>/plugins/<name>-agent/skills/<name>-agent/SKILL.md, <root>/plugin/skills/<name>-agent/SKILL.md]`
  — bundled first (note the plural `plugins` and the doubled `<name>-agent`
  segment), legacy second.

**Where it lives.** `src/hub/index.ts`, `packageRootFromCli` (~line 54),
`skillMdCandidates` (~line 66), used inside `prepareConnector` (~line 139).

**Why it exists.** The legacy plugin layout was singular `plugin/skills/<name>-agent/`.
The bundled monorepo-style layout under `plugins/` nests one extra level
because the package now owns multiple plugin directories side by side. If
either helper reverts to the legacy assumptions, `prepareConnector` returns
`SKILL_NOT_FOUND` and `gather()` fails before ever spawning a connector — even
though the resolver found the CLI correctly.

**How it's locked in.** `tests/hub/gather.test.ts`, two tests:

- `"loads SKILL.md from the bundled 2.x layout (plugins/<name>-agent/skills/<name>-agent/SKILL.md)"`
- `"falls back to the legacy plugin/skills/<name>-agent/SKILL.md layout when the bundled path is absent"`

Both build a fake on-disk layout, stub the CLI resolver to return the
bundled path, and assert the system prompt contains a marker proving the
right `SKILL.md` was loaded.

**History.** Bug shipped in 2.1.1 (resolver-only fix; the hub still assumed
the legacy layout); fixed in 2.1.2.

## 3. Lazy-loading discipline for credentials and db drivers

**What it is.** Optional cloud SDKs and native database bindings must be
loaded via dynamic `import()` only — never top-level `import` — so the bundle
imports cleanly without every optional peer dependency installed.

**Where it lives.**

- `src/credentials/cloud_secrets.ts` (AWS / GCP / Azure secret-manager SDKs).
- `src/connectors/db/lib/drivers/{postgresql,mysql,sqlserver,oracle,mongodb,dynamodb,sqlite}.ts`
  (driver-specific native bindings).

**Why it exists.** Cloud SDKs (`@aws-sdk/*`, `@google-cloud/*`) and database
drivers (`pg`, `mysql2`, `mssql`, `oracledb`, `mongodb`, `@aws-sdk/client-dynamodb`,
`better-sqlite3`) are listed as optional peer dependencies. A consumer that
only uses GitHub + Jira should never have to install Oracle. A static
top-level import would break `import { gather } from "narai-primitives"` for
those consumers with `MODULE_NOT_FOUND` at load time, before any connector
runs.

**How it's locked in.** Two static-analysis regression tests parse the source
files and assert the optional SDK / driver names appear only inside dynamic
`import()` expressions:

- `tests/credentials/lazy_loading.test.ts`
- `tests/connectors/db/lazy_loading.test.ts`

**History.** Discipline established as part of the 2.0 consolidation; both
guard tests landed during the 2.1.x stabilization to make accidental
top-level imports fail CI rather than runtime.

## 4. db schema dispatch: prefer `getSchemaAsync`

**What it is.** `src/connectors/db/dispatcher.ts` `runSchema` must duck-type
`driver.getSchemaAsync` and prefer it over the sync `driver.getSchema`. Sync
`getSchema` is a stub returning `[]` in every Phase E driver (postgres, mysql,
mssql, oracle, mongodb, dynamodb); only sqlite implements the sync method.

**Where it lives.** `src/connectors/db/dispatcher.ts`, `AsyncSchemaDriver`
interface (~line 274) and the dispatch site in `runSchema` (~line 289):

```ts
const asyncHook = (driver as AsyncSchemaDriver).getSchemaAsync;
const tables: Table[] =
  typeof asyncHook === "function"
    ? await asyncHook.call(driver, conn, undefined, filter)
    : driver.getSchema(conn, undefined, filter);
```

**Why it exists.** The Phase E drivers moved their `information_schema`
query logic into async hooks because the underlying SDK calls are async.
The sync `getSchema` was left in place as a `[]`-returning stub to satisfy
the `DatabaseDriver` interface. Before 2.1.3 the dispatcher called the sync
method unconditionally, so every postgres / mysql / mssql / oracle / mongo /
dynamo schema-action call returned `{ status: "ok", tables: [], table_count: 0 }`
on a successful connection — silent failure with no error envelope.

**How it's locked in.** `tests/connectors/db/run_schema.test.ts`:

- `"prefers getSchemaAsync when the driver exposes it"` asserts
  `result.table_count === 1` against a mock driver whose sync `getSchema`
  returns `[]` and whose async hook returns one table.
- `"falls back to sync getSchema when getSchemaAsync is absent"` covers
  the sqlite shape.

**History.** Bug shipped in 2.0.0 (and persisted through 2.1.0–2.1.2); fixed
in 2.1.3.

## When to re-run end-to-end tests

Touching any file named above warrants running doc-wiki's eval-14
(`wiki-gather-credential-boundary`) and eval-20 (`wiki-gather-db-postgres-success`)
in addition to this repo's unit tests. Both evals exercise `gather()` →
connector subprocess → bundled `SKILL.md` → real connector CLI → structured
envelope round-trip. Eval-14 surfaced the 2.1.1 resolver bug and the 2.1.2
SKILL.md-path bug; eval-20 surfaced the 2.1.3 `runSchema` async-dispatch bug.
Every one of those bugs shipped with green unit tests in this repo. Unit
tests are necessary but not sufficient for these four paths.
