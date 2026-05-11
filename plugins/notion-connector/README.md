# notion-connector-plugin

Claude Code plugin that wraps `narai-primitives/notion` as a read-only Notion skill and slash command.

- Skill `notion-connector` — automatic invocation for Notion workspace questions.
- Slash command `/notion-connector <action> <params-json>`.
- Binary `notion-connector` — thin shim over the installed connector CLI.

## How install works

On first `SessionStart` the hook copies `package.json` into
`${CLAUDE_PLUGIN_DATA}` and runs `npm install --no-audit --no-fund` there
once. After that, `${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/dist/connectors/notion/cli.js`
exists and `bin/notion-connector` exec's it.

## Credentials

Export `NOTION_TOKEN` before starting Claude Code, or configure a
credential provider via `@narai/credential-providers`.

## License

MIT
