---
name: gcp-connector
description: |
  Use when the user asks about read-only GCP inventory — Cloud Run services,
  Cloud SQL instances, Pub/Sub topics, or Cloud Logging entries. Queries are
  scoped to a single GCP project. Never modifies GCP resources.
context: fork
---

# GCP Connector

Answer the user's question by invoking the `gcp-connector` binary exposed by
this plugin. It delegates to `narai-primitives/gcp`, which speaks to
GCP by shelling out to `gcloud` / `bq` with Application Default Credentials.

## Invocation

```
gcp-connector --action <action> --params '<json>'
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
| `query_logs` | `project_id`, exactly one of `filter` / `structured_filter`, optional `hours` (default 24, max 168), optional `max_results` (default 100, max 1000) |

Example:

```bash
gcp-connector --action list_services --params '{"project_id":"acme-prod-123"}'
```

### query_logs filters

Prefer `structured_filter` — JSON clauses compiled internally to a Cloud
Logging filter string with correct quoting/escaping. Operators: `=`, `!=`,
`>=`, `<=`, `contains` (alias `:`). Fields are dotted identifier paths
(`severity`, `textPayload`, `trace`, `logName`, `resource.type`,
`resource.labels.*`, `jsonPayload.*`). Clauses combine under `and` / `or`,
nested one level deep. Values are always treated as data — quotes,
backslashes, and newlines in values are escaped, never interpreted as
filter syntax.

```bash
gcp-connector --action query_logs --params '{
  "project_id": "acme-prod-123",
  "structured_filter": {"and": [
    {"field": "resource.type", "op": "=", "value": "k8s_container"},
    {"field": "resource.labels.namespace_name", "op": "=", "value": "prod-app"},
    {"field": "severity", "op": ">=", "value": "ERROR"},
    {"field": "textPayload", "op": "contains", "value": "connection refused"}
  ]}
}'
```

The raw `filter` string remains available for simple unquoted expressions
(e.g. `severity=ERROR`) but rejects semicolons, quotes, and shell
metacharacters — use `structured_filter` for anything needing quoted
values, severity floors, or multi-word search.

Each returned entry has `timestamp`, `severity`, `message` (falls back
`textPayload` → `jsonPayload.message` → stringified `jsonPayload`),
`container`, `namespace`, `pod`, `trace_id`, `log_name`, `insert_id`
(missing values are `null`).

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
