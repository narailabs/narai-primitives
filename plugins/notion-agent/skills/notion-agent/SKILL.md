---
name: notion-agent
description: |
  Use when the user asks about read-only Notion workspace content — search,
  page contents, database schema, or database queries. Never modifies Notion.
context: fork
---

# Notion Agent

Answer the user's question by invoking the `notion-agent` binary exposed
by this plugin. It delegates to `@narai/notion-agent-connector`, which
speaks to the Notion Public API with a `NOTION_TOKEN` integration secret.

## Invocation

```
notion-agent --action <action> --params '<json>'
```

Return the JSON envelope from the CLI verbatim.

## Supported actions

| Action | Required params |
|---|---|
| `search` | `query`, optional `filter_type` (`page`/`database`), optional `max_results` (default 25, max 100) |
| `get_page` | `page_id` (UUID) |
| `get_database` | `database_id` (UUID) |
| `query_database` | `database_id`, optional `filter` object, optional `max_results` |

Example:

```bash
notion-agent --action search --params '{"query":"architecture","filter_type":"page"}'
```

## Credentials

Set `NOTION_TOKEN` to a Notion internal integration secret. The
integration must be invited to the pages/databases you want to read.

## Safety

Read-only by construction: the connector's HTTP method whitelist allows
`GET` plus only two narrow `POST` endpoints (`/v1/search` and
`/v1/databases/{id}/query`, which Notion requires `POST` for despite
being read). No other endpoints can be reached.
