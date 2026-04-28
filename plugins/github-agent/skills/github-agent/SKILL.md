---
name: github-agent
description: |
  Use when the user asks about read-only GitHub data — repository info,
  code search, issue/PR listing, or single-file retrieval. Never
  modifies GitHub.
context: fork
---

# GitHub Agent

Answer the user's question by invoking the `github-agent` binary
exposed by this plugin. It delegates to
`@narai/github-agent-connector` via GitHub's REST v3 + GraphQL APIs.

## Invocation

```
github-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action | Required params |
|---|---|
| `repo_info` | `owner`, `repo` |
| `search_code` | `query`, optional `max_results` |
| `get_issues` | `owner`, `repo`, optional `state`, `max_results` |
| `get_pulls` | `owner`, `repo`, optional `state`, `max_results` |
| `get_file` | `owner`, `repo`, `path`, optional `ref` |

## Credentials

Export `GITHUB_TOKEN` (PAT with `repo` / `read:org` as needed).

## Safety

Read-only — only GET (REST) and POST /graphql (read-only queries)
are permitted.
