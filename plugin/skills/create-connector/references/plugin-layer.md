# The Claude Code plugin layer

Every connector ships a `plugin/` subdirectory that lets Claude Code install and invoke it without any manual setup. Read this when scaffolding the plugin layer or debugging why the SessionStart hook isn't picking up changes.

## What lives in plugin/

```
plugin/
├── .claude-plugin/
│   └── plugin.json              # Manifest (name, version, description, author)
├── hooks/
│   ├── hooks.json               # SessionStart, PostToolUse, SessionEnd hooks
│   └── reminder.mjs             # Best-effort SessionStart curation banner
├── bin/
│   └── <svc>-agent              # Bash shim that execs the published CLI
├── skills/
│   └── <svc>-agent/
│       └── SKILL.md             # Tells Claude how/when to invoke the bin
└── commands/
    └── <svc>-agent.md           # Slash command (/<svc>-agent <action> <params>)
```

The whole `plugin/` tree is excluded from the npm tarball via `.npmignore`. Claude Code installs from the source repo, not from npm.

## The SessionStart hook (hooks.json)

Three commands run at session start, in order:

1. **Idempotent npm install**
   ```
   diff -q "${CLAUDE_PLUGIN_ROOT}/package.json" "${CLAUDE_PLUGIN_DATA}/package.json" \
     || (mkdir -p "${CLAUDE_PLUGIN_DATA}" && cp "${CLAUDE_PLUGIN_ROOT}/package.json" "${CLAUDE_PLUGIN_DATA}/" \
         && cd "${CLAUDE_PLUGIN_DATA}" && npm install --no-audit --no-fund) \
     || rm -f "${CLAUDE_PLUGIN_DATA}/package.json"
   ```

   Diffs the plugin's `package.json` against the cached copy in `${CLAUDE_PLUGIN_DATA}`. If different (or missing), copies + runs `npm install`. On failure, removes the partial copy so the next session retries cleanly. This is what makes `node_modules/@narai/<pkg>/dist/cli.js` available to the bash shim.

2. **Service-specific reminder** (`reminder.mjs`) — best-effort import of the toolkit's nudge module to print a banner if the user has enabled curation. Never blocks startup.

3. **Toolkit stale-summarize hook** — invokes `connector-toolkit/plugin-hooks/stale-summarize.mjs` to surface session activity. Tagged with `USAGE_CONNECTOR_NAME` for cross-connector aggregation.

## PostToolUse + SessionEnd hooks

- **PostToolUse** with matcher `Bash` — invokes `usage-record.mjs` after every Bash call to capture connector usage events. Tagged with `USAGE_CONNECTOR_NAME` and `USAGE_BIN_HINT` for telemetry.
- **SessionEnd** — invokes `session-summary.mjs` to write an end-of-session summary. Same tagging.

All four hook commands swallow errors (`|| true`) — no plugin should ever wedge a session.

## The bash shim (bin/<svc>-agent)

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLAUDE_PLUGIN_DATA:-}" ]; then
  echo "<svc>-agent: CLAUDE_PLUGIN_DATA is not set (run from inside Claude Code)" >&2
  exit 2
fi

CLI="${CLAUDE_PLUGIN_DATA}/node_modules/@narai/<svc>-agent-connector/dist/cli.js"

if [ ! -f "$CLI" ]; then
  echo "<svc>-agent: connector CLI not found at $CLI" >&2
  echo "Restart your Claude Code session to re-run the SessionStart install hook." >&2
  exit 2
fi

exec node "$CLI" "$@"
```

`CLAUDE_PLUGIN_DATA` is set by the runtime to a session-specific cache directory. The shim hands off to `node` with `exec` so the Node process *replaces* the bash process — no fork overhead, signals propagate correctly.

If the CLI is missing, the shim tells the user to restart the session (which re-runs the SessionStart install hook). It does NOT try to install from inside the shim, because that would block on first invocation.

## The plugin SKILL.md (skills/<svc>-agent/SKILL.md)

This is what Claude actually reads to decide when to invoke the connector. Keep it tight:

- **Frontmatter**: `name`, `description`, `context: fork`. The description triggers the skill — make it specific to the service ("read-only Notion content"), not generic.
- **Body**: invocation syntax (`<svc>-agent --action <name> --params '<json>'`), supported actions table, credentials note, safety statement.

The `context: fork` directive matters: it tells Claude Code to load this skill into a subagent context rather than the main one, keeping conversation context clean.

## The slash command (commands/<svc>-agent.md)

A 7-line markdown file with frontmatter + a one-line body:

```markdown
---
description: Run a <svc> action via the <svc>-agent connector
argument-hint: "<action> <params-json>"
---

Invoke the `<svc>-agent` skill with the user's $ARGUMENTS as the action name and params JSON. Return the connector's JSON envelope verbatim.
```

This adds `/<svc>-agent <action> <params-json>` as a typed shortcut for the skill.

## The .npmignore at repo root

Excludes everything that's not the published library:

```
src/
tests/
plugin/
evals/
vitest.config.ts
tsconfig.json
.gitignore
.git/
```

Result: the published npm tarball contains only `dist/`, `README.md`, and `LICENSE`. The plugin lives in the source repo.
