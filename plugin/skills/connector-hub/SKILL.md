---
name: connector-hub
description: |
  Use when the user wants to gather context across multiple read-only
  connectors (jira, github, db, notion, ...) from a single natural-language
  prompt. The hub plans + dispatches connector calls in parallel.
context: fork
---

# Connector Hub

Answer the user's question by invoking the `connector-hub` binary exposed by
this plugin. It delegates to `@narai/connector-hub`, which reads
`~/.connectors/config.yaml` + `./.connectors/config.yaml`, asks the Claude
Agent SDK for a plan, and dispatches each step in parallel.

## Invocation

```
connector-hub --prompt "<user's request>" [--consumer <name>] [--environment <name>] [--extra-context "<text>"]
```

Return the JSON envelope verbatim. The consumer parses `plan` + `results`
themselves.

## Output shape

```ts
{
  plan: [{ connector, action, params }, ...],
  results: [
    { step, connector, action, params, envelope },
    { step, connector, action, params, error: { code, message } },
    ...
  ],
}
```

Errors (planner failures, malformed plan entries, dispatch failures) appear
inline in `results[]` keyed by `error.code` rather than throwing.

## Safety

Read-only — every dispatched connector enforces its own read-only guardrails.
The hub itself only orchestrates; it never writes.

See the package README for full API details.
