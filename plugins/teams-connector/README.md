# teams-connector plugin

Read and write Microsoft Teams data — joined teams, channels, chats,
users, channel and chat messages (with replies, reactions, soft-delete,
and tenant-wide search), online meetings (with transcripts, recordings,
and a substring fan-out search across transcripts), and OneDrive-backed
attachments — through the narai-primitives connector toolkit's policy
gate.

## Credentials

Delegated OAuth via `@azure/msal-node` refresh-token flow. Set:

| Variable             | Purpose |
|----------------------|---------|
| `MS_TENANT_ID`       | Azure AD tenant id (or `common`) |
| `MS_CLIENT_ID`       | App registration client id |
| `MS_CLIENT_SECRET`   | App registration client secret |
| `MS_REFRESH_TOKEN`   | Long-lived delegated refresh token (one-time auth-code exchange) |

The connector requests the `https://graph.microsoft.com/.default` scope.
Configure the following delegated permissions on the app registration
(admin consent required for the recording / transcript scopes):

- `User.Read`, `User.ReadBasic.All`
- `Team.ReadBasic.All`, `Channel.ReadBasic.All`
- `ChannelMessage.Read.All`, `ChannelMessage.Send`, `ChannelMessage.Edit`, `ChannelMessage.SoftDelete`
- `Chat.ReadWrite`, `ChatMessage.Send`
- `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`
- `Files.ReadWrite` (OneDrive uploads for attachments)
- `Search` / `Search.Read` (tenant-wide message search)

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

## Scope limitations

Transcripts and recordings are only accessible for meetings the
signed-in user organized or attended. Meetings hosted by others — and
meetings whose tenant policy disables transcript access — return a
Graph 403; `search_meeting_transcripts` skips them silently.

## Action surface

25 actions across directory (6), messages (11), meetings (7), and
attachments (2). See `skills/teams-connector/SKILL.md` for the full
table.

## How install works

On first `SessionStart` the hook copies `package.json` into
`${CLAUDE_PLUGIN_DATA}` and runs `npm install --no-audit --no-fund`
there once. After that,
`${CLAUDE_PLUGIN_DATA}/node_modules/narai-primitives/dist/connectors/teams/cli.js`
exists and `bin/teams-connector` exec's it.

## License

See repo root.
