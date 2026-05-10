---
name: notion-agent
description: |
  Use when the user asks about Notion workspace content or wants to create,
  update, or archive Notion pages, blocks, and database entries — workspace
  search, page retrieval, database schema, database queries, comments,
  block-level attachments, or any write operation on pages and blocks.
  Supports both read and write surfaces; every action passes the policy gate
  before any network call is made: read actions succeed by default, write and
  delete actions escalate by default, privilege actions are hard-denied.
context: fork
---

# Notion Agent

Answer the user's question by invoking the `notion-agent` binary exposed by
this plugin. It delegates to `narai-primitives/notion`, which enforces the
policy gate before any Notion Public API call is made.

## Invocation

```
notion-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action                   | Classification | Required params                                                            | Optional params                                                   |
|--------------------------|----------------|----------------------------------------------------------------------------|-------------------------------------------------------------------|
| `search`                 | read           | `query`                                                                    | `filter_type` (`page`/`database`), `max_results` (default 25, max 100) |
| `get_page`               | read           | `page_id` (UUID)                                                           |                                                                   |
| `get_database`           | read           | `database_id` (UUID)                                                       |                                                                   |
| `query_database`         | read           | `database_id`                                                              | `filter` (Notion filter object), `max_results` (default 25)       |
| `list_attachments`       | read           | `page_id`                                                                  |                                                                   |
| `get_attachment`         | read           | `page_id`, `block_id`                                                      |                                                                   |
| `get_comments`           | read           | `page_id`                                                                  |                                                                   |
| `create_page`            | write          | `parent` (object), `properties`                                            | `children` (children input)                                       |
| `update_page`            | write          | `page_id`                                                                  | `properties`, `archived`                                          |
| `archive_page`           | write/delete   | `page_id`                                                                  |                                                                   |
| `append_blocks`          | write          | `block_id`, `children` (children input)                                    |                                                                   |
| `update_block`           | write          | `block_id`, `payload` (block update object)                                |                                                                   |
| `delete_block`           | write/delete   | `block_id`                                                                 |                                                                   |
| `create_database_entry`  | write          | `database_id`, `properties`                                                | `children` (children input)                                       |
| `update_database_entry`  | write          | `page_id`, `properties`                                                    |                                                                   |

Note: Notion has no hard-delete via the public API. `archive_page` sets
`archived: true`; `delete_block` archives the block via `DELETE
/v1/blocks/{id}`.

## Envelope shape

**success**
```json
{"status": "success", "action": "create_page", "data": {"id": "1a2b3c4d-...", "url": "https://notion.so/My-Page-1a2b3c4d", "created_time": "2025-05-09T12:00:00.000Z"}}
```

**escalate** (default for write/delete actions)
```json
{"status": "escalate", "action": "create_page", "reason": "WRITE statements require approval"}
```

**denied** (default for privilege actions, or operator-set policy)
```json
{"status": "denied", "action": "archive_page", "reason": "DELETE statements are not allowed"}
```

**error**
```json
{"status": "error", "action": "create_page", "error_code": "VALIDATION_ERROR", "message": "Invalid page_id — expected UUID format", "retriable": false}
```

## Children input (blocks / markdown)

Actions that accept page or block content (`create_page`, `append_blocks`,
`create_database_entry`) use a discriminated union for the `children` field:

**Pre-built Notion block objects**:
```json
{"children": {"format": "blocks", "value": [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": "Hello"}}]}}]}}
```

**Markdown** (auto-converted to Notion blocks via markdownToBlocks):
```json
{"children": {"format": "markdown", "value": "# Title\n\n- one\n- two"}}
```

Markdown conversion supports: paragraphs, headings (h1–h3), bullet lists,
numbered lists, code fences with language, and block quotes. Inline marks
(bold, italic, links) are not converted in v1 — use the `blocks` format for
rich inline formatting.

## Parent object for `create_page`

Pass one of these parent shapes:

```json
{"parent": {"type": "page_id", "page_id": "1a2b3c4d-..."}}
{"parent": {"type": "database_id", "database_id": "1a2b3c4d-..."}}
{"parent": {"type": "workspace", "workspace": true}}
```

## Credentials

Set this environment variable before use:

| Variable       | Description                                                      |
|----------------|------------------------------------------------------------------|
| `NOTION_TOKEN` | Notion internal integration secret                               |

The integration must be invited to the pages and databases you want to
access. Alternatively, register a credential provider via
`narai-primitives/credentials`. Per-workspace credentials can be configured
under `connectors.notion.options.workspaces.<alias>` in
`~/.connectors/config.yaml`.

## Safety

Read AND write surface; the policy gate gates every action before any
network call is made. WRITE escalates by default; DELETE also escalates by
default; PRIVILEGE is hard-denied. Never bypass the `notion-agent` binary to
call the Notion API directly — the binary is the only sanctioned channel.
Never edit the operator's config to weaken a policy decision; report the
decision instead.

Default policy (operator may override under `connectors.notion.policy` in
`~/.connectors/config.yaml`; per-workspace override under
`connectors.notion.options.workspaces.<alias>.policy`):

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
