---
name: teams-connector
description: |
  Use when the user asks about Microsoft Teams data or wants to act on
  Teams — listing teams, channels, chats, and users; reading or posting
  channel and chat messages, including replies and reactions; soft-deleting
  messages; searching messages tenant-wide; listing online meetings and
  pulling transcripts or recordings (including a substring fan-out search
  across transcripts); and uploading/downloading message attachments.
  Supports read and write surfaces; every action passes the policy gate
  before any Graph call is made: reads succeed by default, writes escalate
  by default, delete-aspect actions escalate (floored, cannot be relaxed),
  admin is hard-denied.
context: fork
---

# Teams Connector

Answer the user's question by invoking the `teams-connector` binary exposed
by this plugin. It delegates to `narai-primitives/teams`, which enforces the
policy gate before any Microsoft Graph call is made.

## Invocation

```
teams-connector --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Action surface (~25 actions)

### Directory (read)

| Action          | Required params                  |
|-----------------|----------------------------------|
| `list_teams`    | optional `max_results`           |
| `list_channels` | `team_id`, optional `max_results`|
| `get_channel`   | `team_id`, `channel_id`          |
| `list_chats`    | optional `max_results`           |
| `list_users`    | optional `max_results`           |
| `get_user`      | `user_id` (id or userPrincipalName) |

### Messages

| Action                      | Classify        | Required params |
|-----------------------------|-----------------|-----------------|
| `list_channel_messages`     | read            | `team_id`, `channel_id`, optional `max_results` |
| `get_message_replies`       | read            | `team_id`, `channel_id`, `message_id` |
| `list_chat_messages`        | read            | `chat_id`, optional `max_results` |
| `search_messages`           | read            | `query`, optional `max_results` |
| `post_channel_message`      | write           | `team_id`, `channel_id`, `body` (ContentInput), optional `attachments` |
| `reply_to_channel_message`  | write           | `team_id`, `channel_id`, `message_id`, `body`, optional `attachments` |
| `post_chat_message`         | write           | `chat_id`, `body`, optional `attachments` |
| `update_message`            | write           | `team_id`, `channel_id`, `message_id`, `body` |
| `delete_message`            | write + delete  | `team_id`, `channel_id`, `message_id` |
| `add_reaction`              | write           | `team_id`, `channel_id`, `message_id`, `reaction_type` |
| `remove_reaction`           | write + delete  | `team_id`, `channel_id`, `message_id`, `reaction_type` |

`ContentInput` (`body` field):

```json
{"format": "plain",    "value": "Hello"}
{"format": "markdown", "value": "**bold** and `code`"}
{"format": "html",     "value": "<p>raw</p>"}
```

### Meetings (read)

| Action                          | Required params |
|---------------------------------|-----------------|
| `list_meetings`                 | `since` (ISO), optional `until`, `max_results`, `resolve_meeting_ids` (default false — when true, resolves each event's `join_url` to an `onlineMeeting.id`; costs an extra Graph call per event) |
| `get_meeting`                   | exactly one of `meeting_id` (onlineMeeting id) or `event_id` (calendar event id; resolved via its joinUrl) |
| `list_meeting_transcripts`      | `meeting_id`, optional `max_results` |
| `get_meeting_transcript`        | `meeting_id`, `transcript_id` (returns WebVTT text) |
| `list_meeting_recordings`       | `meeting_id`, optional `max_results` |
| `get_meeting_recording`         | `meeting_id`, `recording_id` (returns metadata + sha256 checksum; no text extraction) |
| `search_meeting_transcripts`    | `query`, `since`, optional `until`, `max_meetings` (default 50, cap 200), `max_transcripts_per_meeting` (default 1, cap 5) |

`list_meetings` and `search_meeting_transcripts` walk `/me/calendar/events`
(`isOnlineMeeting eq true`) because Graph's `/me/onlineMeetings` does not
support date-range filters. The calendar endpoint returns event-derived
data including `join_url`; the underlying onlineMeeting resource (needed
for transcripts/recordings) is resolved via
`/me/onlineMeetings?$filter=joinWebUrl eq '<url>'`.

Transcripts and recordings are scoped to meetings the signed-in user
organized or attended. Meetings hosted by others — and meetings whose
recording policy disables transcript access — return 403; the
`search_meeting_transcripts` fan-out silently skips them. Events whose
`joinUrl` doesn't resolve to a Teams onlineMeeting (e.g. third-party Zoom
links) are also skipped and counted in `unresolvable_events_count`.

### Attachments

| Action               | Classify | Required params |
|----------------------|----------|-----------------|
| `get_attachment`     | read     | `message_id`, `attachment_id`, **either** (`team_id` + `channel_id`) or `chat_id` |
| `upload_attachment`  | write    | `filename`, **either** `content_base64` or `path` (validated for containment), optional `mime_type`, plus the same channel/chat target rule |

## Envelope shape

**success**
```json
{"status": "success", "action": "post_channel_message", "data": {"id": "1733456789012", "body_content": "Hello", ...}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "post_channel_message", "reason": "WRITE statements require approval"}
```

**denied**
```json
{"status": "denied", "action": "some_admin_op", "reason": "ADMIN statements are not allowed"}
```

**error**
```json
{"status": "error", "action": "list_teams", "error_code": "AUTH_ERROR", "message": "InvalidAuthenticationToken: ...", "retriable": false}
```

## Credentials

Set these environment variables (or register them with a credential
provider via `narai-primitives/credentials`):

| Variable             | Purpose |
|----------------------|---------|
| `MS_TENANT_ID`       | Azure AD tenant id (or `common`) |
| `MS_CLIENT_ID`       | App registration client id |
| `MS_CLIENT_SECRET`   | App registration client secret |
| `MS_REFRESH_TOKEN`   | Long-lived delegated refresh token (one-time auth-code exchange) |

The connector requests the `https://graph.microsoft.com/.default` scope,
which tells Entra to issue a token covering all delegated scopes the app
registration is consented for. Configure these delegated permissions on
the app registration (admin consent required for the ones that grant
mailbox/recording access):

- `User.Read`, `User.ReadBasic.All`
- `Team.ReadBasic.All`, `Channel.ReadBasic.All`
- `ChannelMessage.Read.All`, `ChannelMessage.Send`, `ChannelMessage.Edit`, `ChannelMessage.SoftDelete`
- `Chat.ReadWrite`, `ChatMessage.Send`
- `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`
- `Calendars.Read` (required by `list_meetings` and `search_meeting_transcripts`, which walk `/me/calendar/events` because Graph's `/me/onlineMeetings` does not support date-range filters)
- `Files.ReadWrite` (for OneDrive uploads when attaching files)
- `Search` / `Search.Read` (for `search_messages`)

`MS_REFRESH_TOKEN` is obtained out of band — for v0 the operator runs the
auth-code flow once (any standard MSAL sample works) and pastes the
resulting refresh token into the env var. The connector handles in-memory
rotation thereafter.

## Safety

Read + write surface; the policy gate runs before any Graph call. WRITE
escalates by default; the `delete` aspect (delete_message, remove_reaction)
escalates and is floored — operators cannot relax it to `success`. ADMIN
is hard-denied. Never bypass the `teams-connector` binary to call Graph
directly — the binary is the only sanctioned channel.

Default policy (operator may override under `connectors.teams.policy` in
`~/.connectors/config.yaml`):

```yaml
policy:
  read: success
  write: escalate
  admin: denied
  aspects:
    delete: escalate     # cannot be set to success — floored
```
