---
name: slack-connector
description: |
  Use when the user asks about Slack workspace content or wants to post,
  edit, or delete Slack messages, react to messages, or upload files —
  channel listings, channel history, thread replies, user lookups, file
  listings and downloads, message and file search, and any write
  operation on messages, reactions, or files. Supports both read and
  write surfaces; every action passes the policy gate before any network
  call is made: read actions succeed by default, write and delete
  actions escalate by default, privilege actions are hard-denied.
context: fork
---

# Slack Connector

Answer the user's question by invoking the `slack-connector` binary exposed
by this plugin. It delegates to `narai-primitives/slack`, which enforces the
policy gate before any Slack Web API call is made.

## Invocation

```
slack-connector --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action               | Classification | Required params                                | Optional params                                                              |
|----------------------|----------------|------------------------------------------------|------------------------------------------------------------------------------|
| `list_channels`      | read           |                                                | `types` (default `"public_channel,private_channel"`), `max_results` (default 100, max 1000) |
| `get_channel`        | read           | `channel_id`                                   |                                                                              |
| `get_channel_history`| read           | `channel_id`                                   | `max_results` (default 100, max 1000), `oldest` (ts), `latest` (ts)         |
| `get_thread_replies` | read           | `channel_id`, `thread_ts`                      | `max_results` (default 100, max 1000)                                       |
| `list_users`         | read           |                                                | `max_results` (default 200, max 1000)                                        |
| `get_user`           | read           | exactly one of `user_id` or `email`            |                                                                              |
| `list_files`         | read           |                                                | `channel_id`, `user_id`, `max_results` (default 100, max 1000)              |
| `get_file`           | read           | `file_id`                                      |                                                                              |
| `search_messages`    | read           | `query`                                        | `max_results` (default 20, max 100) — requires `SLACK_USER_TOKEN`           |
| `search_files`       | read           | `query`                                        | `max_results` (default 20, max 100) — requires `SLACK_USER_TOKEN`           |
| `post_message`       | write          | `channel_id`, `body` (content input)           |                                                                              |
| `update_message`     | write          | `channel_id`, `ts`, `body` (content input)     |                                                                              |
| `post_thread_reply`  | write          | `channel_id`, `thread_ts`, `body` (content input) |                                                                          |
| `delete_message`     | write/delete   | `channel_id`, `ts`                             |                                                                              |
| `add_reaction`       | write          | `channel_id`, `ts`, `name` (emoji name)        |                                                                              |
| `remove_reaction`    | write/delete   | `channel_id`, `ts`, `name`                     |                                                                              |
| `upload_file`        | write          | `filename`, and exactly one of `content_base64` or `path` | `channel_id`, `mime_type`, `alt_text`                              |

## Envelope shape

**success**
```json
{"status": "success", "action": "post_message", "data": {"channel_id": "C0123", "ts": "1700000000.000100", "posted": true}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "post_message", "reason": "WRITE statements require approval"}
```

**denied** (default for privilege actions, or operator-set policy)
```json
{"status": "denied", "action": "delete_message", "reason": "DELETE actions are not allowed by operator policy"}
```

**error**
```json
{"status": "error", "action": "get_channel", "error_code": "NOT_FOUND", "message": "Slack conversations.info returned channel_not_found", "retriable": false}
```

## Content input (plain / markdown / blocks)

Write actions that accept message body (`post_message`, `update_message`,
`post_thread_reply`) use a discriminated union so callers can choose the
most convenient encoding:

**plain** (sent as Slack `text`):
```json
{"body": {"format": "plain", "value": "Hello world"}}
```

**markdown** (Slack mrkdwn — bold `*x*`, italic `_x_`, links `<url|label>`):
```json
{"body": {"format": "markdown", "value": "*Bold* and _italic_ <https://example.com|link>"}}
```

**blocks** (Block Kit array):
```json
{"body": {"format": "blocks", "value": [{"type": "section", "text": {"type": "mrkdwn", "text": "Hello"}}]}}
```

When `blocks` is used, a brief `text` fallback (`"(rich content)"`) is
attached so push notifications and screen readers have something to read.

## File uploads

`upload_file` accepts either inline base64 or a local file path:

```json
{"channel_id": "C0123", "filename": "report.pdf", "content_base64": "JVBERi0xLjQK…"}
{"channel_id": "C0123", "filename": "screenshot.png", "path": "./uploads/screenshot.png"}
```

Path inputs must resolve under the current working directory (validated
via the toolkit's `checkPathContainment`); any path that escapes CWD
returns a `VALIDATION_ERROR` envelope without making any network call.

The connector handles Slack's 2-step external-upload flow internally:
`files.getUploadURLExternal` → raw POST of bytes → `files.completeUploadExternal`.

## Credentials

| Variable                  | Description                                                                  |
|---------------------------|------------------------------------------------------------------------------|
| `SLACK_BOT_TOKEN`         | Bot user OAuth token (`xoxb-…`). Required.                                   |
| `SLACK_USER_TOKEN`        | User OAuth token (`xoxp-…`). Required only for `search_messages` / `search_files`. |
| `SLACK_DEFAULT_TEAM_ID`   | Workspace id (e.g. `T0123456`). Optional; used to scope audit + hardship records. |

Alternatively, register a credential provider via
`narai-primitives/credentials`. Per-workspace credentials can be configured
under `connectors.slack.options.workspaces.<alias>` in
`~/.connectors/config.yaml`.

## Safety

Read AND write surface; the policy gate gates every action before any
network call is made. WRITE escalates by default; DELETE also escalates by
default; PRIVILEGE is hard-denied. Never bypass the `slack-connector`
binary to call the Slack Web API directly — the binary is the only
sanctioned channel. Never edit the operator's config to weaken a policy
decision; report the decision instead.

Default policy (operator may override under `connectors.slack.policy` in
`~/.connectors/config.yaml`; per-workspace override under
`connectors.slack.options.workspaces.<alias>.policy`):

```yaml
policy:
  read: allow
  write: escalate
  delete: escalate
  admin: deny
  privilege: deny
```

The `admin` and `privilege` rules cannot be set to `allow`, and the
`delete` aspect cannot be downgraded to `allow` — the safety floor is
enforced at config load.
