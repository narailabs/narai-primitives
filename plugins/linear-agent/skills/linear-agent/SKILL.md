---
name: linear-agent
description: |
  Use when the user asks about Linear data or wants to create, update, or
  archive Linear content — issue search, issue details, project metadata,
  comments, attachment links, or any write operation on issues and comments.
  Supports both read and write surfaces; every action passes the policy gate
  before any network call is made: read actions succeed by default, write and
  delete actions escalate by default, privilege actions are hard-denied.
context: fork
---

# Linear Agent

Answer the user's question by invoking the `linear-agent` binary exposed by
this plugin. It delegates to `narai-primitives/linear`, which enforces the
policy gate before any Linear GraphQL call is made.

## Invocation

```
linear-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action               | Classification | Required params                                          | Optional params                                                            |
|----------------------|----------------|----------------------------------------------------------|----------------------------------------------------------------------------|
| `get_issue`          | read           | `id` (identifier like `ENG-123` or UUID)                 |                                                                            |
| `search_issues`      | read           |                                                          | `team_key`, `state`, `assignee_email`, `text`, `max_results` (default 50) |
| `get_project`        | read           | `id` (UUID)                                              |                                                                            |
| `get_team`           | read           | `key_or_id` (team key like `ENG` or UUID)                |                                                                            |
| `get_comments`       | read           | `issue_id`                                               | `max_results` (default 50)                                                 |
| `list_attachments`   | read           | `issue_id`                                               |                                                                            |
| `get_attachment`     | read           | `attachment_id`                                          | Use `list_attachments` first to get the URL; then fetch externally.        |
| `create_issue`       | write          | `team_id`, `title`                                       | `description` (markdown), `assignee_id`, `label_ids`, `priority`, `parent_id` |
| `update_issue`       | write          | `id`                                                     | `title`, `description`, `assignee_id`, `state_id`, `priority`             |
| `archive_issue`      | write/delete   | `id`                                                     |                                                                            |
| `add_comment`        | write          | `issue_id`, `body` (markdown)                            |                                                                            |
| `update_comment`     | write          | `comment_id`, `body` (markdown)                          |                                                                            |
| `delete_comment`     | write/delete   | `comment_id`                                             |                                                                            |
| `attachment_link`    | write          | `issue_id`, `title`, `url`                               | `subtitle`, `metadata`                                                     |

## Envelope shape

**success**
```json
{"status": "success", "action": "create_issue", "data": {"id": "abc-uuid", "identifier": "ENG-123", "url": "https://linear.app/team/issue/ENG-123", "title": "Fix login bug", "created_at": "2026-05-01T00:00:00.000Z"}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "create_issue", "reason": "WRITE statements require approval"}
```

**denied** (default for privilege actions, or operator-set policy)
```json
{"status": "denied", "action": "archive_issue", "reason": "DELETE actions are not allowed by operator policy"}
```

**error**
```json
{"status": "error", "action": "get_issue", "error_code": "NOT_FOUND", "message": "Issue 'ENG-999' not found", "retriable": false}
```

## Issue identifiers

Linear issues can be addressed two ways:

- **Identifier** (human-readable): `ENG-123` — team key + number
- **UUID** (internal): `abc12345-...` — 32+ hex character UUID

Both formats are accepted by `get_issue`, `search_issues`, `get_comments`,
`list_attachments`, `update_issue`, `archive_issue`, `add_comment`.

## Descriptions and comments

Linear is **markdown-native**. Pass descriptions and comment bodies as plain
markdown strings — no ADF conversion needed:

```json
{
  "team_id": "team-uuid",
  "title": "Fix login redirect",
  "description": "## Problem\n\nUsers are redirected to a blank page after login.\n\n## Steps to reproduce\n\n1. Log out\n2. Log in again"
}
```

## Priority values

Linear priorities map to integers:

| Value | Label     |
|-------|-----------|
| 0     | No priority |
| 1     | Urgent    |
| 2     | High      |
| 3     | Medium    |
| 4     | Low       |

## Attachment linking

Linear does not host files via the public API. Use `attachment_link` to
associate an externally-hosted URL with an issue:

```json
{
  "issue_id": "ENG-123",
  "title": "Design mockup",
  "url": "https://figma.com/file/abc",
  "subtitle": "v3 iteration"
}
```

## Credentials

Set this environment variable before use:

| Variable          | Description                                  |
|-------------------|----------------------------------------------|
| `LINEAR_API_KEY`  | Linear personal API key                      |

Obtain from Linear → Settings → API → Personal API keys.

The authorization header is `Authorization: <api_key>` (no `Bearer` prefix —
this is Linear-specific).

Alternatively, configure under `connectors.linear.options.api_key` in
`~/.connectors/config.yaml`.

## Safety

Read AND write surface; the policy gate gates every action before any network
call is made. WRITE escalates by default; DELETE also escalates by default;
PRIVILEGE is hard-denied. Never bypass the `linear-agent` binary to call the
Linear GraphQL API directly — the binary is the only sanctioned channel. Never
edit the operator's config to weaken a policy decision; report the decision
instead.

`archive_issue` and `delete_comment` are classified as `{kind: "write", aspects: ["delete"]}`.
Linear has no hard-delete via the public API; `archive_issue` invokes the
`issueArchive` mutation which sets `archivedAt`.

Default policy (operator may override under `connectors.linear.policy` in
`~/.connectors/config.yaml`):

```yaml
policy:
  read: allow
  write: escalate
  delete: escalate
  admin: deny
  privilege: deny
```

The `admin` and `privilege` rules cannot be set to `allow` — the safety floor
is enforced at config load.
