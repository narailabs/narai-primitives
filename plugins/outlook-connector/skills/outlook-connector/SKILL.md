---
name: outlook-connector
description: |
  Use when the user asks about Outlook (Microsoft 365) email — reading the
  inbox or other mail folders, fetching individual messages, searching the
  mailbox by free-text, listing or downloading attachments, sending email,
  replying to a thread, moving messages between folders, or soft-deleting
  (moving to Deleted Items). Supports read and write surfaces; every action
  passes the policy gate before any Microsoft Graph call is made: reads
  succeed by default, writes escalate by default, the `delete` aspect
  escalates (floored, cannot be relaxed), admin is hard-denied.
context: fork
---

# Outlook Connector

Answer the user's question by invoking the `outlook-connector` binary
exposed by this plugin. It delegates to `narai-primitives/outlook`, which
enforces the policy gate before any Microsoft Graph call is made.

## Invocation

```
outlook-connector --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Action surface (10 actions)

| Action              | Classify        | Required params                              | Optional params                                  |
|---------------------|-----------------|----------------------------------------------|--------------------------------------------------|
| `list_messages`     | read            |                                              | `folder_id` (default `"inbox"`), `max_results` (default 25, cap 250) |
| `get_message`       | read            | `message_id`                                 | `expand_attachments` (default `false`)           |
| `search_messages`   | read            | `query`                                      | `max_results` (default 25, cap 100)              |
| `list_folders`      | read            |                                              | `max_results` (default 25, cap 250)              |
| `list_attachments`  | read            | `message_id`                                 |                                                  |
| `get_attachment`    | read            | `message_id`, `attachment_id`                |                                                  |
| `send_message`      | write           | `to` (non-empty array), `subject`, `body` (ContentInput) | `cc`, `bcc`, `save_to_sent_items` (default `true`) |
| `reply_to_message`  | write           | `message_id`, **either** `comment` (text) or `body` (ContentInput) |                                                  |
| `delete_message`    | write + delete  | `message_id`                                 |                                                  |
| `move_message`      | write           | `message_id`, `destination_folder_id`        |                                                  |

### `ContentInput`

```json
{"format": "plain",    "value": "Hello"}
{"format": "markdown", "value": "**bold** and `code`"}
{"format": "html",     "value": "<p>raw</p>"}
```

`plain` is sent as `Text`; `markdown` is rendered to HTML then sent;
`html` is sent verbatim.

### Recipient shape

`to` / `cc` / `bcc` accept either a bare email string or an object with
`address` (required) and `name` (optional):

```json
{"to": ["a@example.com", {"address": "b@example.com", "name": "Bob"}]}
```

### Folder ids

`folder_id` / `destination_folder_id` accept either a Graph folder id or a
well-known name: `inbox`, `archive`, `sentitems`, `drafts`, `deleteditems`,
`junkemail`, `outbox`, `clutter`, `conflicts`, `conversationhistory`,
`localfailures`, `msgfolderroot`, `recoverableitemsdeletions`, `scheduled`,
`searchfolders`, `serverfailures`, `syncissues`.

### Soft-delete semantics

`delete_message` is a soft delete: it `POST`s `/me/messages/{id}/move`
with `destinationId: "deleteditems"`. This matches the standard Outlook
delete UX. To permanently purge a message, move it to the deleted-items
folder via `delete_message` and then call `move_message` again — though
v0 has no hard-delete action by design.

## Envelope shape

**success**
```json
{"status": "success", "action": "list_messages", "data": {"folder_id": "inbox", "total": 25, "truncated": true, "messages": [...]}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "send_message", "reason": "WRITE statements require approval"}
```

**denied**
```json
{"status": "denied", "action": "some_admin_op", "reason": "ADMIN statements are not allowed"}
```

**error**
```json
{"status": "error", "action": "get_message", "error_code": "NOT_FOUND", "message": "itemNotFound: ...", "retriable": false}
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

The connector requests the `https://graph.microsoft.com/.default` scope.
Configure these delegated permissions on the app registration:

- `Mail.ReadWrite` (read/move/soft-delete + list attachments)
- `Mail.Send` (send + reply)
- `offline_access` (refresh-token lifetime)

`MS_REFRESH_TOKEN` is obtained out of band — for v0 the operator runs the
auth-code flow once (any standard MSAL sample works) and pastes the
resulting refresh token into the env var. The connector handles in-memory
rotation thereafter.

### Sharing the Entra app with teams-connector

If you already have `teams-connector` working, you can reuse the same
`MS_*` env vars and the same Entra app — just add the Mail scopes above
to that app registration and re-mint a refresh token that covers them
both. No second app required.

## Safety

Read + write surface; the policy gate runs before any Graph call. WRITE
escalates by default; the `delete` aspect (`delete_message`) escalates
and is floored — operators cannot relax it to `success`. ADMIN is
hard-denied. Never bypass the `outlook-connector` binary to call Graph
directly — the binary is the only sanctioned channel.

Default policy (operator may override under `connectors.outlook.policy`
in `~/.connectors/config.yaml`):

```yaml
policy:
  read: success
  write: escalate
  admin: denied
  aspects:
    delete: escalate     # cannot be set to success — floored
```
