# narai-primitives

Read-only connectors + planning hub + connector framework, in one package.

Bundles what used to ship as eight separate `@narai/*` packages:

- `@narai/connector-toolkit` → `narai-primitives/toolkit`
- `@narai/connector-config` → `narai-primitives/config`
- `@narai/connector-hub` → `narai-primitives` (default) or `narai-primitives/hub`
- `@narai/aws-agent-connector` → `narai-primitives/aws`
- `@narai/confluence-agent-connector` → `narai-primitives/confluence`
- `@narai/db-agent-connector` → `narai-primitives/db`
- `@narai/gcp-agent-connector` → `narai-primitives/gcp`
- `@narai/github-agent-connector` → `narai-primitives/github`
- `@narai/jira-agent-connector` → `narai-primitives/jira`
- `@narai/notion-agent-connector` → `narai-primitives/notion`

`@narai/credential-providers` stays as a separate package.

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

The eight old packages are deprecated on npm and will receive no new releases.
