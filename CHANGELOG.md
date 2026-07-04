# Changelog

All notable changes to `narai-primitives` are documented here.

## 2.6.0 — 2026-07-03

### gcp connector — `query_logs` expressiveness (additive)

- **New `structured_filter` param** for `query_logs`: JSON clauses
  (`{field, op, value}` with one level of `and`/`or` nesting) compiled
  internally to a Cloud Logging filter string with correct quoting and
  escaping. This makes exact matches (`resource.type="k8s_container"`),
  severity floors (`severity>="ERROR"`), multi-word text search
  (`textPayload:"connection refused"`), trace lookups, and
  `jsonPayload.*` matches expressible — none of which the raw `filter`
  string allows under its quote/semicolon sanitization. Injection safety
  comes by construction: `op` is an allowlist (`=`, `!=`, `>=`, `<=`,
  `contains`/`:`), `field` must be a dotted identifier, and values are
  always escaped quoted data. Exactly one of `filter` /
  `structured_filter` must be provided; the raw `filter` param keeps its
  existing strict sanitization.
- **Scoped the shell-metachar blocklist** in the gcloud client: the
  filter positional of `gcloud logging read` is now exempt (same
  precedent as the `bq query` SQL body — the client spawns via
  `execFileSync` argv arrays, never a shell), so raw filters like
  `severity>=ERROR` no longer fail with `UNSAFE_ARG`. Flag positions
  remain blocklisted; `ALLOWED_SUBCOMMANDS` is unchanged.
- **Richer, backward-compatible log entry projection**: `message` now
  falls back `textPayload` → `jsonPayload.message` →
  `JSON.stringify(jsonPayload)` (truncated to ~2KB) → `null`, so
  structured-JSON loggers no longer come back with empty messages. New
  fields on every entry (null when absent, never omitted): `container`,
  `namespace`, `pod` (from `resource.labels`), `trace_id`, `log_name`,
  `insert_id`.
- Exported `compileLogFilter`, `LogFilterError`, and the filter types
  from `narai-primitives/gcp`.

### Docs

- jira/confluence connector skill docs: corrected the policy-override
  location to the actual discovery paths (`~/.<name>-agent/config.yaml`
  user-level, `<cwd>/.<name>-agent/config.yaml` repo overlay) and the
  policy vocabulary (`success` / `escalate` / `denied`); previously they
  pointed at `connectors.<name>.policy` in `~/.connectors/config.yaml`,
  which the policy loader does not read.

## 2.5.0 and earlier

See the [GitHub releases](https://github.com/narailabs/narai-primitives/releases).
