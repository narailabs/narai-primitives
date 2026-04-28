---
name: gcp-agent
description: |
  Use when the user asks about read-only GCP inventory — Cloud Run services,
  Cloud SQL instances, Pub/Sub topics, or Cloud Logging entries. Queries are
  scoped to a single GCP project. Never modifies GCP resources.
context: fork
---

# GCP Agent

Answer the user's question by invoking the `gcp-agent` binary exposed by
this plugin. It delegates to `@narai/gcp-agent-connector`, which speaks to
GCP by shelling out to `gcloud` / `bq` with Application Default Credentials.

## Invocation

```
gcp-agent --action <action> --params '<json>'
```

The CLI writes a single JSON envelope to stdout and exits 0 on success, 1
on a handled error, 2 on CLI misuse. Return the envelope verbatim to the
orchestrator.

## Supported actions

| Action | Required params |
|---|---|
| `list_services` | `project_id` |
| `describe_db` | `project_id`, `instance_id`, optional `database` |
| `list_topics` | `project_id` |
| `query_logs` | `project_id`, `filter`, optional `hours` (default 24, max 168), optional `max_results` (default 100, max 1000) |

Example:

```bash
gcp-agent --action list_services --params '{"project_id":"acme-prod-123"}'
```

## Credentials

Uses Application Default Credentials. Before first use, run:

```bash
gcloud auth application-default login
```

## Safety

Read-only by construction: the connector enforces a binary and sub-command
whitelist at the `execFileSync` layer, forbids shell strings, and refuses
write-style flags. Cannot invoke `create`, `delete`, `update`, or any
mutating `gcloud` sub-command.
