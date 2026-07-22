# Changelog

## 2.7.0 — 2026-07-21

### plugin-hooks: ask memoization ("approve once per workload")

- **`memo` gate-rule field.** An `ask` rule may opt in to memoization with
  `"memo": { "scope": "repo_branch" | "exact_command", "idle_minutes": 30,
  "max_hours": 8 }`. After the operator approves the ask once, identical
  workload hits replay as an `allow` — announced via `systemMessage` with a
  revocation phrase — instead of re-prompting. Rules without `memo` are never
  memoized; `deny` rules never consult the store.
- **Workload model.** Scope identity is primary (`repo_branch` = git repo
  toplevel + remote + branch, re-resolved from the live repository on every
  replay, so different branches are independent grants and an unobserved
  branch switch can never fire a stale grant). Freshness is a sliding idle
  window (`idle_minutes` after last use, refreshed on each replay), with
  `max_hours` as an outer backstop. A `git checkout`/`git switch` observed on
  `post-tool-use` deterministically drops the repo's stale-branch grants;
  grants are session-keyed so session end drops all.
- **Grants require proof of approval.** The PreToolUse miss records a pending
  entry; the `post-tool-use` event — which fires only if the tool actually
  ran, i.e. the ask was approved — promotes it to a grant. Execution under
  `bypassPermissions`-style permission modes is not trusted as approval.
- **Activation and audit.** Inert unless `NARAI_MEMO_PATH` points at a state
  directory (mirrors `NARAI_AUDIT_PATH`); `NARAI_MEMO_DISABLE=1` is the kill
  switch. Zero-state dispatcher output is byte-identical to 2.6.0 (proven on
  an 18-case battery). Replays, grants, and invalidations are audited as
  `guardrail_memo_replay` / `guardrail_memo_granted` /
  `guardrail_memo_invalidated`. New `plugin-hooks/memo.mjs` CLI:
  `clear` (revocation), `status`, `prune`.
- **Scope resolution fails closed** on non-git directories, detached HEAD,
  non-literal `cd` targets, delete/force/mapped refspecs, extra positionals,
  and substring false-positives (`echo git push` can never arm a grant).
- **git-connector preset** (`plugins/git-connector`, 1.1.0): the `push` ask
  rule now carries the standard `memo` example
  (`repo_branch`, 30 min idle, 8 h backstop) — inert until the operator sets
  `NARAI_MEMO_PATH`.
- `post-tool-use` still runs usage-record exactly as before; when memoization
  is active the captured stdin is replayed to it through a subprocess.

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
