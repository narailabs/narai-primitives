---
name: confluence-agent
description: |
  Use when the user asks about read-only Confluence content — search via
  CQL, single page retrieval, or space metadata. Never modifies
  Confluence content.
context: fork
---

# Confluence Agent

Answer the user's question by invoking the `confluence-agent` binary
exposed by this plugin. It delegates to
`narai-primitives/confluence` via Atlassian's Confluence REST v1.

## Invocation

```
confluence-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action | Required params |
|---|---|
| `cql_search` | `cql`, optional `max_results` |
| `get_page` | `page_id` (numeric), optional `expand` |
| `get_space` | `space_key` (e.g. `DEV`) |

## Credentials

Set `CONFLUENCE_SITE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`
before use.

## Safety

Read-only — only GET requests are permitted by the connector's HTTP
method whitelist.
