# outlook-connector plugin

Read and write Outlook (Microsoft 365) email through the narai-primitives
connector toolkit's policy gate. Ten v0 actions cover the basic email
surface: list/get/search messages, list folders, list/get attachments
(with text extraction), send, reply, move, and soft-delete.

## Credentials

Delegated OAuth via `@azure/msal-node` refresh-token flow. Set:

| Variable             | Purpose |
|----------------------|---------|
| `MS_TENANT_ID`       | Azure AD tenant id (or `common`) |
| `MS_CLIENT_ID`       | App registration client id |
| `MS_CLIENT_SECRET`   | App registration client secret |
| `MS_REFRESH_TOKEN`   | Long-lived delegated refresh token (one-time auth-code exchange) |

The connector requests the `https://graph.microsoft.com/.default` scope.
Configure the following delegated permissions on the app registration:

- `Mail.ReadWrite` (read, move, soft-delete)
- `Mail.Send` (send + reply)
- `offline_access` (required to mint the long-lived refresh token)

## Shared Entra app with teams-connector

The same `MS_*` env vars and same Entra app registration that back
`teams-connector` work here — just add the Mail scopes above to that app
registration and the existing refresh token will cover both connectors.
If you only need Outlook, register a standalone app with the three scopes
above.

## One-time bootstrap

For v0, the operator obtains `MS_REFRESH_TOKEN` out of band. Any standard
MSAL auth-code sample works — register the app with a redirect URI of
`http://localhost:<port>/redirect`, sign in interactively, exchange the
returned auth code for a token, and copy the `refresh_token` into the
environment. The connector handles in-memory rotation thereafter; on
process restart, re-supply the env var.

## Config

Operator config is read from `~/.connectors/config.yaml`. Example:

```yaml
policy:
  read: success
  write: escalate
  admin: denied
  aspects:
    delete: escalate         # cannot be set to success — floored
approval_mode: confirm_once
```

## Action surface

10 actions: `list_messages`, `get_message`, `search_messages`,
`list_folders`, `list_attachments`, `get_attachment`, `send_message`,
`reply_to_message`, `delete_message`, `move_message`. See
`skills/outlook-connector/SKILL.md` for the full table.

## How install works

On first `SessionStart` the hook copies `package.json` into
`${CLAUDE_PLUGIN_DATA}` and runs `npm install --no-audit --no-fund`
there once. After that,
`${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/dist/connectors/outlook/cli.js`
exists and `bin/outlook-connector` exec's it.

## License

See repo root.
