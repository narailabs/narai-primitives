# Changelog

## 2.6.0 — 2026-07-03

### gcp connector

- **`query_logs` structured filters.** New optional `structured_filter`
  param: JSON clauses compiled internally to a Cloud Logging filter string
  with correct quoting/escaping. Allowlisted operators (`=`, `!=`, `>=`,
  `<=`, `contains`/`:`), fields validated against a dotted-identifier
  pattern, values always emitted as escaped quoted literals — injection
  safety by construction. Supports `and`/`or` groups nested one level deep.
  This makes previously inexpressible queries work: exact matches
  (`resource.type="k8s_container"`), severity floors (`severity>="ERROR"`),
  multi-word text search (`textPayload:"connection refused"`), trace and
  `jsonPayload.*` lookups. Exactly one of `filter` / `structured_filter`
  must be provided; the raw `filter` string keeps its original strict
  sanitization and behaves exactly as before.
- **Richer `query_logs` entry projection.** `message` now falls back
  `textPayload` → `jsonPayload.message` → `JSON.stringify(jsonPayload)`
  (truncated to ~2KB), so structured-JSON loggers no longer come back with
  empty messages. New per-entry fields, always present and `null` when
  missing: `container`, `namespace`, `pod` (from `resource.labels`),
  `trace_id`, `log_name`, `insert_id`.
- **`GcpClient.queryLogsStructured`** added; compiled filters are exempt
  from the argv metachar blocklist only in the filter position (arguments
  never traverse a shell — the client uses `execFileSync`). Command and
  binary allowlists, read-only posture, and all other validation are
  unchanged.
