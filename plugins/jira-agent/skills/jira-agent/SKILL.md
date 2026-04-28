---
name: jira-agent
description: |
  Use when the user asks about read-only Jira data — JQL search, single
  issue details, or project metadata. Never modifies Jira.
context: fork
---

# Jira Agent

Answer the user's question by invoking the `jira-agent` binary exposed
by this plugin. It delegates to `@narai/jira-agent-connector` via
Atlassian's Jira REST v3.

## Invocation

```
jira-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action | Required params |
|---|---|
| `jql_search` | `jql`, optional `max_results` (default 50, max 500) |
| `get_issue` | `issue_key` (e.g. `FOO-123`), optional `expand` |
| `get_project` | `project_key` (e.g. `FOO`) |

## Credentials

Set `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` before use.

## Safety

Read-only — only GET requests permitted.
