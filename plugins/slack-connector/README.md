# slack-connector-plugin

Claude Code plugin that wraps `narai-primitives/slack` as a read + write Slack skill and slash command.

- Skill `slack-connector` — automatic invocation for Slack workspace questions.
- Slash command `/slack-connector <action> <params-json>`.
- Binary `slack-connector` — thin shim over the installed connector CLI.

## How install works

On first `SessionStart` the hook copies `package.json` into
`${CLAUDE_PLUGIN_DATA}` and runs `npm install --no-audit --no-fund` there
once. After that, `${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/dist/connectors/slack/cli.js`
exists and `bin/slack-connector` exec's it.

## Credentials

Export the following before starting Claude Code (or configure a credential
provider via `narai-primitives/credentials`):

```bash
export SLACK_BOT_TOKEN="xoxb-…"            # required — bot-scoped Slack token
export SLACK_USER_TOKEN="xoxp-…"           # optional — required only for search_messages / search_files
export SLACK_DEFAULT_TEAM_ID="T0123456"    # optional — tags audit / hardship records
```

## Required Slack scopes (bot token)

| Action surface         | Scopes                                                    |
|------------------------|-----------------------------------------------------------|
| Channel reads          | `channels:read`, `groups:read`                            |
| Channel history        | `channels:history`, `groups:history`                      |
| User reads             | `users:read`, `users:read.email`                          |
| File reads             | `files:read`                                              |
| Message writes         | `chat:write`                                              |
| Reactions              | `reactions:write`                                         |
| File uploads           | `files:write`                                             |

`search_messages` and `search_files` require a user token (`xoxp-…`) with
`search:read` — Slack does not expose search to bot tokens.

## License

MIT
