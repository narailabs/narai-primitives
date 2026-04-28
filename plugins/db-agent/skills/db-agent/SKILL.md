---
name: db-agent
description: |
  Use when the user asks about reading data from a database — SELECT queries,
  schema introspection, "show me the rows/tables/columns…". Supports
  PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, DynamoDB, and Oracle via
  pluggable drivers. Every statement passes the policy gate BEFORE any
  driver loads or any connection opens: write statements escalate, delete
  and admin statements return formatted SQL without executing, privilege
  statements are hard-denied.
context: fork
---

# Database Agent

Answer the user's question by invoking the `db-agent` binary exposed by this
plugin. It delegates to `@narai/db-agent-connector`, which enforces the
policy gate before any backend is touched.

## Invocation

```
db-agent --action <action> --params '<json>'
```

Return the connector's JSON envelope verbatim.

## Supported actions

| Action   | Required params                               | Optional params                                                   |
|----------|-----------------------------------------------|-------------------------------------------------------------------|
| `query`  | `env` + `sql` (or `sqlite_path` + `sql`)      | `max_rows` (default 1000), `timeout_ms` (default 30000), `approval_mode`, `config_path` |
| `schema` | `env` (or `sqlite_path`)                      | `filter` (table-name pattern like `users%`), `config_path`        |

## Envelope statuses

- `ok` — read succeeded; `rows` / `tables` / `row_count` / `columns` / `truncated` populated.
- `present_only` — formatted SQL returned, **never executed**. Default for `delete` (DELETE/TRUNCATE) and `admin` (CREATE/DROP/ALTER/RENAME).
- `denied` — `privilege` (GRANT/REVOKE) always; or the configured policy denied.
- `escalate` — needs approval. Default for `write` (INSERT/UPDATE/REPLACE/MERGE/UPSERT); also `grant_required` mode and unbounded SELECT.
- `error` — driver or SQL error after an allowed verdict.

## Safety

Read-only by design. The policy gate rejects every non-read statement before
any driver loads. WRITE escalates by default; DELETE/ADMIN return formatted
SQL with no execution; PRIVILEGE is hard-denied. Never shell out to `psql`,
`mysql`, `sqlite3`, `mongosh`, `pg_dump`, `duckdb`, or `aws dynamodb` — the
`db-agent` binary is the only sanctioned channel. Never edit the operator's
config to weaken a policy decision; report the decision instead.
