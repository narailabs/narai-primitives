---
name: confluence-agent
description: |
  Use when the user asks about Confluence content or wants to create, update,
  or delete Confluence pages and comments — CQL search, page retrieval, space
  metadata, comments, attachments, or any write operation on pages. Supports
  both read and write surfaces; every action passes the policy gate before
  any network call is made: read actions succeed by default, write and delete
  actions escalate by default, privilege actions are hard-denied.
context: fork
---

# Confluence Agent

Answer the user's question by invoking the `confluence-agent` binary exposed
by this plugin. It delegates to `narai-primitives/confluence`, which enforces
the policy gate before any Atlassian Confluence REST v1 call is made.

## Invocation

```
confluence-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action             | Classification | Required params                                                       | Optional params                                      |
|--------------------|----------------|-----------------------------------------------------------------------|------------------------------------------------------|
| `cql_search`       | read           | `cql`                                                                 | `max_results` (default 25, max 500)                  |
| `get_page`         | read           | `page_id` (numeric string or number)                                  | `expand` (array of expand fields)                    |
| `get_space`        | read           | `space_key` (e.g. `DEV`)                                              |                                                      |
| `list_attachments` | read           | `page_id`                                                             | `limit` (default 25)                                 |
| `get_attachment`   | read           | `page_id`, `attachment_id`                                            |                                                      |
| `get_comments`     | read           | `page_id`                                                             | `limit` (default 50)                                 |
| `create_page`      | write          | `space_key`, `title`, `body` (content input)                          | `parent_id`                                          |
| `update_page`      | write          | `page_id`, `title`, `body` (content input), `expected_version`        |                                                      |
| `delete_page`      | write/delete   | `page_id`                                                             |                                                      |
| `add_comment`      | write          | `page_id`, `body` (content input)                                     |                                                      |
| `post_attachment`  | write          | `page_id`, `files` (array — see Multipart upload)                     |                                                      |

## Envelope shape

**success**
```json
{"status": "success", "action": "create_page", "data": {"id": "98765", "title": "My Page", "version": 1}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "create_page", "reason": "WRITE statements require approval"}
```

**denied** (default for privilege actions, or operator-set policy)
```json
{"status": "denied", "action": "delete_page", "reason": "DELETE actions are not allowed by operator policy"}
```

**error**
```json
{"status": "error", "action": "create_page", "error_code": "VALIDATION_ERROR", "message": "Invalid ADF: root.type must be 'doc'", "retriable": false}
```

## Content input (ADF / markdown / plain)

Fields that accept body text (`body`) use a discriminated union so you can
pass whichever format is most convenient:

**markdown** (converted via marklassian; output validated via assertValidAdf):
```json
{"body": {"format": "markdown", "value": "# Title\n\nSome **bold** text."}}
```

**ADF** (passed through; validated via assertValidAdf):
```json
{"body": {"format": "adf", "value": {"type": "doc", "version": 1, "content": []}}}
```

**plain** (wrapped in an ADF paragraph node):
```json
{"body": {"format": "plain", "value": "Just text."}}
```

`update_page` requires `expected_version` (the current version number as
returned by `get_page` or `cql_search`); the connector increments it by one
before sending the PUT request.

## Multipart upload

`post_attachment` uploads one or more files to a page. Each entry in `files`
is either inline base64 or a local path:

```json
{
  "page_id": "98765",
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

| Variable                  | Description                                       |
|---------------------------|---------------------------------------------------|
| `CONFLUENCE_SITE_URL`     | Your Atlassian site URL (e.g. `https://acme.atlassian.net`) |
| `CONFLUENCE_EMAIL`        | Atlassian account email                           |
| `CONFLUENCE_API_TOKEN`    | Atlassian API token                               |

Alternatively, register a credential provider via
`narai-primitives/credentials`. Per-site credentials can be configured
under `connectors.confluence.options.sites.<alias>` in
`~/.connectors/config.yaml`.

## Safety

Read AND write surface; the policy gate gates every action before any
network call is made. WRITE escalates by default; DELETE also escalates by
default; PRIVILEGE is hard-denied. Never bypass the `confluence-agent`
binary to call the Atlassian REST API directly — the binary is the only
sanctioned channel. Never edit the operator's config to weaken a policy
decision; report the decision instead.

Default policy (operator may override under `connectors.confluence.policy`
in `~/.connectors/config.yaml`; per-site override under
`connectors.confluence.options.sites.<alias>.policy`):

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
