---
name: jira-agent
description: |
  Use when the user asks about Jira data or wants to create, update, or
  delete Jira content — JQL search, issue details, project metadata,
  comments, attachments, status transitions, or any write operation on
  issues and comments. Supports both read and write surfaces; every action
  passes the policy gate before any network call is made: read actions
  succeed by default, write and delete actions escalate by default,
  privilege actions are hard-denied.
context: fork
---

# Jira Agent

Answer the user's question by invoking the `jira-agent` binary exposed by
this plugin. It delegates to `narai-primitives/jira`, which enforces the
policy gate before any Atlassian REST v3 call is made.

## Invocation

```
jira-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action              | Classification | Required params                                                              | Optional params                                                           |
|---------------------|----------------|------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| `jql_search`        | read           | `jql`                                                                        | `max_results` (default 50, max 500)                                       |
| `get_issue`         | read           | `issue_key` (e.g. `PROJ-123`)                                                | `expand` (array of field names)                                           |
| `get_project`       | read           | `project_key` (e.g. `PROJ`)                                                  |                                                                           |
| `list_attachments`  | read           | `issue_key`                                                                  |                                                                           |
| `get_attachment`    | read           | `issue_key`, `attachment_id`                                                 |                                                                           |
| `get_comments`      | read           | `issue_key`                                                                  | `max_results` (default 50)                                                |
| `create_issue`      | write          | `project_key`, `issue_type`, `summary`                                       | `description` (content input), `labels`, `assignee_account_id`, `parent_key` |
| `update_issue`      | write          | `issue_key`                                                                  | `summary`, `description` (content input), `labels`, `assignee_account_id` |
| `delete_issue`      | write/delete   | `issue_key`                                                                  |                                                                           |
| `add_comment`       | write          | `issue_key`, `body` (content input)                                          |                                                                           |
| `update_comment`    | write          | `issue_key`, `comment_id`, `body` (content input)                            |                                                                           |
| `delete_comment`    | write/delete   | `issue_key`, `comment_id`                                                    |                                                                           |
| `transition_issue`  | write          | `issue_key`, `transition_id`                                                 | `comment` (content input)                                                 |
| `post_attachment`   | write          | `issue_key`, `files` (array — see Multipart upload)                          |                                                                           |

## Envelope shape

**success**
```json
{"status": "success", "action": "create_issue", "data": {"key": "PROJ-123", "id": "10456", "self": "https://acme.atlassian.net/rest/api/3/issue/10456"}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "create_issue", "reason": "WRITE statements require approval"}
```

**denied** (default for privilege actions, or operator-set policy)
```json
{"status": "denied", "action": "delete_issue", "reason": "DELETE statements are not allowed"}
```

**error**
```json
{"status": "error", "action": "create_issue", "error_code": "VALIDATION_ERROR", "message": "Invalid ADF: root.type must be 'doc'", "retriable": false}
```

## Content input (ADF / markdown / plain)

Fields that accept body text (`description`, `body`, `comment`) use a
discriminated union so you can pass whichever format is most convenient:

**markdown** (converted via marklassian; output validated via assertValidAdf):
```json
{"description": {"format": "markdown", "value": "# Title\n\nSome **bold** text."}}
```

**ADF** (passed through; validated via assertValidAdf):
```json
{"description": {"format": "adf", "value": {"type": "doc", "version": 1, "content": []}}}
```

**plain** (wrapped in an ADF paragraph node):
```json
{"description": {"format": "plain", "value": "Just text."}}
```

## Multipart upload

`post_attachment` uploads one or more files to an issue. Each entry in
`files` is either inline base64 or a local path:

```json
{
  "issue_key": "PROJ-1",
  "files": [
    {"filename": "report.pdf", "content_base64": "JVBERi..."},
    {"path": "./uploads/screenshot.png"}
  ]
}
```

Path inputs must resolve under the current working directory (validated via
the toolkit's `checkPathContainment`); any path that escapes CWD returns a
`VALIDATION_ERROR` envelope without making any network call.

## Credentials

Set these environment variables before use:

| Variable         | Description                                  |
|------------------|----------------------------------------------|
| `JIRA_SITE_URL`  | Your Atlassian site URL (e.g. `https://acme.atlassian.net`) |
| `JIRA_EMAIL`     | Atlassian account email                      |
| `JIRA_API_TOKEN` | Atlassian API token                          |

Alternatively, register a credential provider via
`narai-primitives/credentials`. Per-site credentials can be configured
under `connectors.jira.options.sites.<alias>` in
`~/.connectors/config.yaml`.

## Safety

Read AND write surface; the policy gate gates every action before any
network call is made. WRITE escalates by default; DELETE also escalates by
default; PRIVILEGE is hard-denied. Never bypass the `jira-agent` binary to
call the Atlassian REST API directly — the binary is the only sanctioned
channel. Never edit the operator's config to weaken a policy decision;
report the decision instead.

Default policy (operator may override under `connectors.jira.policy` in
`~/.connectors/config.yaml`; per-site override under
`connectors.jira.options.sites.<alias>.policy`):

```yaml
policy:
  read: allow
  write: escalate
  delete: escalate
  admin: deny
  privilege: deny
```

The `admin` and `privilege` rules cannot be set to `allow` — the safety
floor is enforced at config load.
