# gcp-agent-plugin

Claude Code plugin that wraps [`narai-primitives/gcp`](https://www.npmjs.com/package/narai-primitives) as a read-only GCP skill and slash command.

- **Skill** `gcp-agent` — automatic invocation for Cloud Run / Cloud SQL / Pub/Sub / Cloud Logging questions.
- **Slash command** `/gcp-agent <action> <params-json>`.
- **Binary** `gcp-agent` — thin shim over the installed connector CLI.

## How install works

On first `SessionStart` the hook in `hooks/hooks.json`:

1. compares the plugin's `package.json` with `${CLAUDE_PLUGIN_DATA}/package.json`;
2. if different or missing, copies the manifest and runs `npm install --no-audit --no-fund` inside `${CLAUDE_PLUGIN_DATA}`;
3. if the install fails, removes the stale copy so the hook re-runs next session.

After install,
`${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/dist/connectors/gcp/cli.js`
exists and `bin/gcp-agent` exec's it.

## Credentials

Install the Google Cloud SDK and authenticate:

```bash
gcloud auth application-default login
```

## License

MIT
