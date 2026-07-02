# narai-primitives

Read-only connectors, a planning hub, a connector toolkit, and credential
resolution for agent tooling — one npm dependency instead of N hand-rolled
service integrations.

- **One `gather()` call.** `gather({ prompt, consumer })` plans against each
  connector's bundled documentation, dispatches the plan in parallel as
  connector subprocesses, and returns the plan plus structured results.
- **Nine connectors behind one dependency.** `aws`, `confluence`, `db`
  (postgres, mysql, sqlite, mssql, mongodb, dynamodb, oracle), `gcp`,
  `github`, `gitlab`, `jira`, `linear`, `notion`.
- **Read-only by default.** Every connector action is classified
  (`read` / `write` / `delete` / `admin` / `privilege`). Reads auto-approve;
  writes and deletes escalate through the toolkit's policy gate;
  admin and privilege actions require an explicit grant.
- **Credentials stay inside the connector process.** Config references such as
  `password: env:DB_PW` are expanded in the connector subprocess — the calling
  agent never handles secrets. The `/credentials` subpath adds a resolver with
  env-var, file, OS-keychain, and cloud-secret-manager providers for code that
  opts in by registering them; the stock connector bootstrap expands `env:`
  references only. Cloud SDKs and database drivers are optional dependencies,
  loaded lazily only when used.
- **Repo config can tighten policy, never escalate it.** User-level
  `~/.connectors/config.yaml` deep-merges with a per-repo overlay; the overlay
  can retarget servers and tighten rules but cannot lift the
  admin/privilege ceiling.

## Install

```sh
npm install narai-primitives
```

## Library use

```ts
import { gather } from "narai-primitives";

const out = await gather({
  prompt: "What was the last commit on main in narailabs/foo?",
  consumer: "doc-wiki",
});
console.log(out.plan);
console.log(out.results);
```

## CLI

Each connector ships its own CLI binary, plus the umbrella `narai` dispatcher:

```sh
# umbrella
npx narai jira list_issues --project AUTH

# individual (back-compat aliases)
npx jira-agent-connector --action list_issues --params '{"project":"AUTH"}'
```

## Bundled packages and subpaths

Bundles what used to ship as eleven separate `@narai/*` packages:

- `@narai/connector-toolkit` → `narai-primitives/toolkit`
- `@narai/connector-config` → `narai-primitives/config`
- `@narai/connector-hub` → `narai-primitives` (default) or `narai-primitives/hub`
- `@narai/credential-providers` → `narai-primitives/credentials`
- `@narai/aws-agent-connector` → `narai-primitives/aws`
- `@narai/confluence-agent-connector` → `narai-primitives/confluence`
- `@narai/db-agent-connector` → `narai-primitives/db`
- `@narai/gcp-agent-connector` → `narai-primitives/gcp`
- `@narai/github-agent-connector` → `narai-primitives/github`
- `@narai/jira-agent-connector` → `narai-primitives/jira`
- `@narai/notion-agent-connector` → `narai-primitives/notion`

The `gitlab` and `linear` connectors were added natively in 2.x
(`narai-primitives/gitlab`, `narai-primitives/linear`); they never shipped as
standalone `@narai/*` packages.

## Migration from the old `@narai/*` packages

Update imports:

```diff
-import { gather } from "@narai/connector-hub";
-import { createConnector } from "@narai/connector-toolkit";
-import { loadResolvedConfig } from "@narai/connector-config";
+import { gather } from "narai-primitives";
+import { createConnector } from "narai-primitives/toolkit";
+import { loadResolvedConfig } from "narai-primitives/config";
```

All eleven old packages are deprecated on npm and will receive no new releases.

## Configuration

Connectors read `~/.connectors/config.yaml` (user defaults) with
`<cwd>/.connectors/config.yaml` (repo overlay) merged on top. For the `db`
connector specifically — overriding a server target and policy per-repo, and the
admin/privilege ceiling that an overlay cannot bypass — see
[`docs/db-layered-config.md`](docs/db-layered-config.md).

External-write gating for the API connectors (asking or denying state-changing
HTTP before it runs) is operator-configurable via per-connector `gates.json`
manifests. See [`docs/external-write-gating.md`](docs/external-write-gating.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors touching `src/toolkit/agent_resolver.ts`, `src/hub/index.ts`, `src/credentials/`, or `src/connectors/db/` should also read [`docs/architecture-invariants.md`](docs/architecture-invariants.md).
