# Template sync strategy

Templates in `assets/templates/connector/` are snapshots of `notion-agent-connector` files (the canonical reference) at a specific point in time. They will drift as the canonical pattern evolves — toolkit upgrades, new hook types, version pin bumps, etc. This doc tells you how to detect and apply that drift.

## Last synced

- **Date**: 2026-04-26
- **Source connector**: `/Users/narayan/src/connectors/notion-agent-connector/`
- **Toolkit version pinned**: `@narai/connector-toolkit ^3.1.0` (workspace published `3.4.0`)
- **Sibling pins**: `@narai/credential-providers ^0.2.1`, `@narai/connector-config ^1.1.0`, `zod ^3.23.0`

## Source-of-truth file mapping

| Template | Canonical source | Substitutions applied |
|---|---|---|
| `package.json.tmpl` | `notion-agent-connector/package.json` | `notion` → `{{SERVICE_SLUG}}`, version reset to `0.1.0` |
| `tsconfig.json` | `notion-agent-connector/tsconfig.json` | none (literal copy) |
| `vitest.config.ts.tmpl` | `notion-agent-connector/vitest.config.ts` | `TEST_LIVE_NOTION` → `TEST_LIVE_{{SERVICE_SLUG_UPPER}}` |
| `LICENSE` | `notion-agent-connector/LICENSE` | none |
| `.npmignore` | `notion-agent-connector/.npmignore` | comment line slug |
| `README.md.tmpl` | `notion-agent-connector/README.md` | name, action table, env var name |
| `src/cli.ts.tmpl` | `notion-agent-connector/src/cli.ts` | `NOTION` → slug, env mapping body |
| `src/lib/error.ts.tmpl` | `notion-agent-connector/src/lib/notion_error.ts` | `Notion` → `{{ServicePascal}}` |
| `src/lib/client.ts.tmpl` | `notion-agent-connector/src/lib/notion_client.ts` (frame only) | full reshape (auth header, methods, types removed) |
| `src/index.ts.tmpl` | `notion-agent-connector/src/index.ts` (skeleton only) | full reshape (param schemas, actions removed) |
| `tests/unit/cli.test.ts.tmpl` | `notion-agent-connector/tests/unit/cli.test.ts` (helpers only) | service-name swap |
| `tests/unit/client_extras.test.ts.tmpl` | per-method test pattern from notion's tests | starter slot |
| `tests/integration/framework.test.ts.tmpl` | `notion-agent-connector/tests/integration/framework.test.ts` (one happy-path) | service-name swap |
| `plugin/.claude-plugin/plugin.json.tmpl` | `notion-agent-connector/plugin/.claude-plugin/plugin.json` | name + description |
| `plugin/hooks/hooks.json.tmpl` | `notion-agent-connector/plugin/hooks/hooks.json` | `notion` → slug |
| `plugin/hooks/reminder.mjs.tmpl` | `notion-agent-connector/plugin/hooks/reminder.mjs` | `notion` → slug |
| `plugin/bin/service-agent.tmpl` | `notion-agent-connector/plugin/bin/notion-agent` | `notion` → slug, package name |
| `plugin/skills/service-agent/SKILL.md.tmpl` | `notion-agent-connector/plugin/skills/notion-agent/SKILL.md` | full reshape |
| `plugin/commands/service-agent.md.tmpl` | `notion-agent-connector/plugin/commands/notion-agent.md` | `notion` → slug |

## Re-sync procedure

When notion-agent-connector changes in a way that should propagate to new scaffolds:

1. **Identify the changed file(s)** in notion-agent. If it's a content change to a templated file, the template needs updating. If it's notion-specific behavior (e.g., a new Notion API endpoint), don't propagate.

2. **Diff the canonical against the template** (treating placeholders as free variables):
   ```bash
   diff -u \
     <(sed 's/notion/{{SERVICE_SLUG}}/g; s/Notion/{{ServicePascal}}/g; s/NOTION/{{SERVICE_SLUG_UPPER}}/g' /Users/narayan/src/connectors/notion-agent-connector/<file>) \
     /Users/narayan/.claude/skills/create-connector/assets/templates/connector/<file>.tmpl
   ```

3. **Apply non-substitution diffs** to the template. Test by scaffolding a fresh connector and running `npm install && npm run build && npm run typecheck && npm test`.

4. **Update this doc**: bump the "Last synced" date and any version pins that changed.

## Major bump checklist

When `@narai/connector-toolkit` ships a major version (e.g., `^3.x` → `^4.0.0`):

1. Read the toolkit's CHANGELOG for breaking changes.
2. Update the version pin in `package.json.tmpl`.
3. Re-run all eval test cases in `evals/evals.json` against the new toolkit. Confirm scaffolds still build clean.
4. Update template internals if APIs shifted (e.g., `createConnector` signature, error code taxonomy, `mapError` semantics).
5. Update `references/connector-anatomy.md` with any contract changes.

## Detecting drift in the wild

The skill's verification step (`npm install && npm run build && npm run typecheck && npm test` on a fresh scaffold) catches drift the moment a new connector fails to build. If a user reports "scaffold doesn't typecheck against latest toolkit", that's the trigger to re-sync.

Soft signals to watch for:

- A new connector PR in the workspace adds a file the templates don't have.
- The toolkit publishes a new helper that materially simplifies client code.
- A new plugin hook type appears in another connector's `hooks.json`.
